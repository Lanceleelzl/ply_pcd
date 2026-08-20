# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import asyncio
import json
import math
import os
import shutil
import time
import uuid
from pathlib import Path
from typing import Annotated, Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel


RUNTIME_ROOT = Path(os.getenv("REGISTRATION_RUNTIME_ROOT", "/data/runtime")).resolve()
WORKER_PATH = os.getenv("REGISTRATION_WORKER_PATH", "/usr/local/bin/registration_worker")
WORKER_TIMEOUT_SECONDS = int(os.getenv("REGISTRATION_WORKER_TIMEOUT_SECONDS", "1800"))
MAX_CONCURRENT_JOBS = int(os.getenv("REGISTRATION_MAX_CONCURRENT_JOBS", "1"))
RESULT_RETENTION_HOURS = int(os.getenv("REGISTRATION_RESULT_RETENTION_HOURS", "168"))
CLEANUP_INTERVAL_SECONDS = int(os.getenv("REGISTRATION_CLEANUP_INTERVAL_SECONDS", "3600"))
UPLOAD_CHUNK_BYTES = 1024 * 1024

app = FastAPI(title="PLY/PCD Registration Service", version="0.1.0")
STATIC_ROOT = Path(__file__).parent / "static"
app.mount("/assets", StaticFiles(directory=STATIC_ROOT / "assets", check_dir=False), name="web-assets")
_job_semaphore = asyncio.Semaphore(MAX_CONCURRENT_JOBS)
_background_tasks: set[asyncio.Task[None]] = set()


class ManualRegistrationRequest(BaseModel):
    initial_pcd_to_ply: list[list[float]]
    min_rms_decrease: float = 1.0e-5
    sampling_limit: int = 50000
    overlap: float = 1.0
    random_seed: int = 42


def _job_directory(job_id: str) -> Path:
    try:
        parsed = uuid.UUID(job_id)
    except ValueError as error:
        raise HTTPException(status_code=404, detail="Job not found") from error
    return RUNTIME_ROOT / "jobs" / str(parsed)


def _manual_session_directory(session_id: str) -> Path:
    try:
        parsed = uuid.UUID(session_id)
    except ValueError as error:
        raise HTTPException(status_code=404, detail="Manual registration session not found") from error
    return RUNTIME_ROOT / "manual-sessions" / str(parsed)


def _status_path(job_directory: Path) -> Path:
    return job_directory / "status.json"


def _write_status(job_directory: Path, status: dict[str, Any]) -> None:
    status["updated_at_unix"] = time.time()
    temporary = job_directory / "status.json.tmp"
    temporary.write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(_status_path(job_directory))


def _read_status(job_directory: Path) -> dict[str, Any]:
    path = _status_path(job_directory)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Job not found")
    return json.loads(path.read_text(encoding="utf-8"))


async def _save_upload(upload: UploadFile, destination: Path) -> int:
    total = 0
    with destination.open("wb") as output:
        while chunk := await upload.read(UPLOAD_CHUNK_BYTES):
            output.write(chunk)
            total += len(chunk)
    await upload.close()
    return total


async def _run_worker(job_id: str, command: list[str]) -> None:
    job_directory = _job_directory(job_id)
    status = _read_status(job_directory)
    async with _job_semaphore:
        status["status"] = "running"
        status["started_at_unix"] = time.time()
        _write_status(job_directory, status)
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(), timeout=WORKER_TIMEOUT_SECONDS
                )
            except asyncio.TimeoutError:
                process.kill()
                await process.communicate()
                status.update(status="failed", error_code="worker_timeout", error="Registration timed out")
                status["finished_at_unix"] = time.time()
                _write_status(job_directory, status)
                shutil.rmtree(job_directory / "input", ignore_errors=True)
                return

            (job_directory / "worker.stdout.log").write_bytes(stdout)
            (job_directory / "worker.stderr.log").write_bytes(stderr)
            if process.returncode != 0:
                message = stderr.decode("utf-8", errors="replace").strip()
                status.update(
                    status="failed",
                    error_code="worker_failed",
                    worker_exit_code=process.returncode,
                    error=message or "Registration worker failed",
                )
            else:
                result_path = job_directory / "result" / "registration.json"
                if not result_path.is_file():
                    status.update(status="failed", error_code="missing_result", error="Worker produced no result")
                else:
                    status.update(status="succeeded", result_url=f"/api/v1/registrations/{job_id}/result")
        except Exception as error:  # Keep API alive if worker startup itself fails.
            status.update(status="failed", error_code="worker_start_failed", error=str(error))
        status["finished_at_unix"] = time.time()
        _write_status(job_directory, status)
        shutil.rmtree(job_directory / "input", ignore_errors=True)


async def _run_preview(session_id: str, command: list[str]) -> None:
    session_directory = _manual_session_directory(session_id)
    status = _read_status(session_directory)
    async with _job_semaphore:
        status["status"] = "preparing"
        status["started_at_unix"] = time.time()
        _write_status(session_directory, status)
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(
                process.communicate(), timeout=WORKER_TIMEOUT_SECONDS
            )
            (session_directory / "worker.stdout.log").write_bytes(stdout)
            (session_directory / "worker.stderr.log").write_bytes(stderr)
            if process.returncode != 0:
                message = stderr.decode("utf-8", errors="replace").strip()
                status.update(status="failed", error_code="preview_worker_failed", error=message)
            else:
                metadata_path = session_directory / "preview" / "metadata.json"
                if not metadata_path.is_file():
                    status.update(status="failed", error_code="missing_preview", error="Worker produced no preview")
                else:
                    status.update(
                        status="ready",
                        metadata=json.loads(metadata_path.read_text(encoding="utf-8")),
                        ply_preview_url=f"/api/v1/manual-registration-sessions/{session_id}/preview/ply",
                        pcd_preview_url=f"/api/v1/manual-registration-sessions/{session_id}/preview/pcd",
                    )
                    if status["metadata"].get("gaussian_available"):
                        status["gaussian_preview_url"] = f"/api/v1/manual-registration-sessions/{session_id}/preview/gaussian"
        except asyncio.TimeoutError:
            process.kill()
            await process.communicate()
            status.update(status="failed", error_code="preview_timeout", error="Preview generation timed out")
        except Exception as error:
            status.update(status="failed", error_code="preview_start_failed", error=str(error))
        status["finished_at_unix"] = time.time()
        _write_status(session_directory, status)


def _cleanup_completed_jobs() -> None:
    jobs_directory = RUNTIME_ROOT / "jobs"
    if not jobs_directory.is_dir():
        return
    expires_before = time.time() - RESULT_RETENTION_HOURS * 3600
    for job_directory in jobs_directory.iterdir():
        if not job_directory.is_dir():
            continue
        try:
            uuid.UUID(job_directory.name)
            status = _read_status(job_directory)
        except (ValueError, HTTPException, OSError, json.JSONDecodeError):
            continue
        if status.get("status") not in {"succeeded", "failed"}:
            continue
        shutil.rmtree(job_directory / "input", ignore_errors=True)
        if float(status.get("updated_at_unix", 0)) < expires_before:
            shutil.rmtree(job_directory)

    sessions_directory = RUNTIME_ROOT / "manual-sessions"
    if not sessions_directory.is_dir():
        return
    for session_directory in sessions_directory.iterdir():
        if not session_directory.is_dir():
            continue
        try:
            uuid.UUID(session_directory.name)
            status = _read_status(session_directory)
        except (ValueError, HTTPException, OSError, json.JSONDecodeError):
            continue
        if status.get("status") not in {"ready", "failed"}:
            continue
        if float(status.get("updated_at_unix", 0)) < expires_before:
            shutil.rmtree(session_directory)


async def _cleanup_loop() -> None:
    while True:
        await asyncio.to_thread(_cleanup_completed_jobs)
        await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)


@app.on_event("startup")
async def start_cleanup() -> None:
    task = asyncio.create_task(_cleanup_loop())
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


def _validate_registration_parameters(
    min_rms_decrease: float, sampling_limit: int, overlap: float, random_seed: int
) -> None:
    if not 1.0e-8 <= min_rms_decrease <= 1.0e-3:
        raise HTTPException(status_code=400, detail="min_rms_decrease must be between 1e-8 and 1e-3")
    if not 10000 <= sampling_limit <= 500000:
        raise HTTPException(status_code=400, detail="sampling_limit must be between 10000 and 500000")
    if not 0.5 <= overlap <= 1.0:
        raise HTTPException(status_code=400, detail="overlap must be between 0.5 and 1.0")
    if not 0 <= random_seed <= 4294967295:
        raise HTTPException(status_code=400, detail="Invalid registration parameters")


def _validate_initial_matrix(matrix: list[list[float]]) -> None:
    if len(matrix) != 4 or any(len(row) != 4 for row in matrix):
        raise HTTPException(status_code=400, detail="initial_pcd_to_ply must be a 4x4 matrix")
    if any(not isinstance(value, (int, float)) or not math.isfinite(value) for row in matrix for value in row):
        raise HTTPException(status_code=400, detail="initial_pcd_to_ply must contain only numbers")
    tolerance = 1.0e-5
    if any(abs(matrix[3][column] - (1.0 if column == 3 else 0.0)) > tolerance for column in range(4)):
        raise HTTPException(status_code=400, detail="initial_pcd_to_ply must have last row [0, 0, 0, 1]")
    for column in range(3):
        length_squared = sum(matrix[row][column] ** 2 for row in range(3))
        if abs(length_squared - 1.0) > tolerance:
            raise HTTPException(status_code=400, detail="initial_pcd_to_ply rotation must not contain scale")
    for left in range(3):
        for right in range(left + 1, 3):
            dot = sum(matrix[row][left] * matrix[row][right] for row in range(3))
            if abs(dot) > tolerance:
                raise HTTPException(status_code=400, detail="initial_pcd_to_ply rotation must be orthogonal")
    determinant = (
        matrix[0][0] * (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1])
        - matrix[0][1] * (matrix[1][0] * matrix[2][2] - matrix[1][2] * matrix[2][0])
        + matrix[0][2] * (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0])
    )
    if abs(determinant - 1.0) > tolerance:
        raise HTTPException(status_code=400, detail="initial_pcd_to_ply rotation determinant must be +1")


@app.post("/api/v1/manual-registration-sessions", status_code=202)
async def create_manual_registration_session(
    ply: Annotated[UploadFile, File(description="Gaussian Splatting PLY model")],
    pcd: Annotated[UploadFile, File(description="SLAM PCD data cloud")],
) -> dict[str, Any]:
    if not (ply.filename or "").lower().endswith(".ply"):
        raise HTTPException(status_code=400, detail="ply file must use .ply extension")
    if not (pcd.filename or "").lower().endswith(".pcd"):
        raise HTTPException(status_code=400, detail="pcd file must use .pcd extension")
    session_id = str(uuid.uuid4())
    session_directory = _manual_session_directory(session_id)
    input_directory = session_directory / "input"
    preview_directory = session_directory / "preview"
    input_directory.mkdir(parents=True)
    preview_directory.mkdir()
    ply_path = input_directory / "model.ply"
    pcd_path = input_directory / "data.pcd"
    try:
        ply_bytes = await _save_upload(ply, ply_path)
        pcd_bytes = await _save_upload(pcd, pcd_path)
        if ply_bytes == 0 or pcd_bytes == 0:
            raise HTTPException(status_code=400, detail="Uploaded files must not be empty")
    except Exception:
        shutil.rmtree(session_directory, ignore_errors=True)
        raise
    status: dict[str, Any] = {
        "session_id": session_id,
        "status": "queued",
        "created_at_unix": time.time(),
        "inputs": {"ply_bytes": ply_bytes, "pcd_bytes": pcd_bytes},
        "editor_url": f"/manual-registration/{session_id}",
    }
    _write_status(session_directory, status)
    command = [
        WORKER_PATH,
        "prepare-preview",
        "--ply", str(ply_path),
        "--pcd", str(pcd_path),
        "--output-dir", str(preview_directory),
        "--ply-limit", "300000",
        "--pcd-limit", "300000",
    ]
    task = asyncio.create_task(_run_preview(session_id, command))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return {
        "session_id": session_id,
        "status": "queued",
        "status_url": f"/api/v1/manual-registration-sessions/{session_id}",
        "editor_url": f"/manual-registration/{session_id}",
    }


@app.get("/api/v1/manual-registration-sessions/{session_id}")
async def get_manual_registration_session(session_id: str) -> dict[str, Any]:
    return _read_status(_manual_session_directory(session_id))


@app.get("/api/v1/manual-registration-sessions/{session_id}/preview/{cloud}")
async def get_manual_registration_preview(session_id: str, cloud: str) -> FileResponse:
    filenames = {
        "ply": "ply-points.bin",
        "pcd": "pcd-points.bin",
        "gaussian": "ply-gaussian-preview.ply",
    }
    if cloud not in filenames:
        raise HTTPException(status_code=404, detail="Preview not found")
    path = _manual_session_directory(session_id) / "preview" / filenames[cloud]
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Preview not found")
    media_type = "application/octet-stream" if cloud != "gaussian" else "application/ply"
    return FileResponse(path, media_type=media_type, filename=filenames[cloud])


@app.post("/api/v1/manual-registration-sessions/{session_id}/register", status_code=202)
async def register_manual_session(
    session_id: str, request: ManualRegistrationRequest
) -> dict[str, Any]:
    _validate_initial_matrix(request.initial_pcd_to_ply)
    _validate_registration_parameters(
        request.min_rms_decrease, request.sampling_limit, request.overlap, request.random_seed
    )
    session_directory = _manual_session_directory(session_id)
    session_status = _read_status(session_directory)
    if session_status.get("status") != "ready":
        raise HTTPException(status_code=409, detail=f"Manual session status is {session_status.get('status')}")
    job_id = str(uuid.uuid4())
    job_directory = _job_directory(job_id)
    input_directory = job_directory / "input"
    result_directory = job_directory / "result"
    input_directory.mkdir(parents=True)
    result_directory.mkdir()
    matrix_path = input_directory / "initial_pcd_to_ply.txt"
    matrix_path.write_text(
        "\n".join(" ".join(f"{value:.17g}" for value in row) for row in request.initial_pcd_to_ply) + "\n",
        encoding="utf-8",
    )
    status: dict[str, Any] = {
        "job_id": job_id,
        "status": "queued",
        "created_at_unix": time.time(),
        "manual_session_id": session_id,
        "inputs": session_status["inputs"],
    }
    _write_status(job_directory, status)
    command = [
        WORKER_PATH,
        "register",
        "--ply", str(session_directory / "input" / "model.ply"),
        "--pcd", str(session_directory / "input" / "data.pcd"),
        "--initial-matrix", str(matrix_path),
        "--output-dir", str(result_directory),
        "--min-rms-decrease", str(request.min_rms_decrease),
        "--sampling-limit", str(request.sampling_limit),
        "--overlap", str(request.overlap),
        "--random-seed", str(request.random_seed),
    ]
    task = asyncio.create_task(_run_worker(job_id, command))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return {"job_id": job_id, "status": "queued", "status_url": f"/api/v1/registrations/{job_id}"}


@app.post("/api/v1/registrations", status_code=202)
async def create_registration(
    ply: Annotated[UploadFile, File(description="Gaussian Splatting PLY model")],
    pcd: Annotated[UploadFile, File(description="SLAM PCD data cloud")],
    min_rms_decrease: Annotated[float, Form()] = 1.0e-5,
    sampling_limit: Annotated[int, Form()] = 50000,
    overlap: Annotated[float, Form()] = 1.0,
    random_seed: Annotated[int, Form()] = 42,
) -> dict[str, Any]:
    if not (ply.filename or "").lower().endswith(".ply"):
        raise HTTPException(status_code=400, detail="ply file must use .ply extension")
    if not (pcd.filename or "").lower().endswith(".pcd"):
        raise HTTPException(status_code=400, detail="pcd file must use .pcd extension")
    _validate_registration_parameters(min_rms_decrease, sampling_limit, overlap, random_seed)

    job_id = str(uuid.uuid4())
    job_directory = _job_directory(job_id)
    input_directory = job_directory / "input"
    result_directory = job_directory / "result"
    input_directory.mkdir(parents=True)
    result_directory.mkdir()
    ply_path = input_directory / "model.ply"
    pcd_path = input_directory / "data.pcd"
    try:
        ply_bytes = await _save_upload(ply, ply_path)
        pcd_bytes = await _save_upload(pcd, pcd_path)
        if ply_bytes == 0 or pcd_bytes == 0:
            raise HTTPException(status_code=400, detail="Uploaded files must not be empty")
    except Exception:
        shutil.rmtree(job_directory, ignore_errors=True)
        raise

    status: dict[str, Any] = {
        "job_id": job_id,
        "status": "queued",
        "created_at_unix": time.time(),
        "inputs": {"ply_bytes": ply_bytes, "pcd_bytes": pcd_bytes},
    }
    _write_status(job_directory, status)
    command = [
        WORKER_PATH,
        "register",
        "--ply", str(ply_path),
        "--pcd", str(pcd_path),
        "--output-dir", str(result_directory),
        "--min-rms-decrease", str(min_rms_decrease),
        "--sampling-limit", str(sampling_limit),
        "--overlap", str(overlap),
        "--random-seed", str(random_seed),
    ]
    task = asyncio.create_task(_run_worker(job_id, command))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return {"job_id": job_id, "status": "queued", "status_url": f"/api/v1/registrations/{job_id}"}


@app.get("/api/v1/registrations/{job_id}")
async def get_registration(job_id: str) -> dict[str, Any]:
    return _read_status(_job_directory(job_id))


@app.get("/api/v1/registrations/{job_id}/result")
async def get_registration_result(job_id: str) -> dict[str, Any]:
    job_directory = _job_directory(job_id)
    status = _read_status(job_directory)
    if status["status"] != "succeeded":
        raise HTTPException(status_code=409, detail=f"Job status is {status['status']}")
    result = json.loads((job_directory / "result" / "registration.json").read_text(encoding="utf-8"))
    return {
        "recommended_matrix": {
            "name": "T_ply_to_pcd",
            "direction": "PLY_TO_PCD",
            "formula": "p_pcd = T_ply_to_pcd * p_ply",
            "usage": "Use this matrix to transform Gaussian PLY points into the SLAM PCD coordinate system.",
            "value": result["ply_to_pcd"],
            "cloudcompare_value": result["ply_to_pcd_cloudcompare"],
        },
        **result,
    }


@app.get("/api/v1/registrations/{job_id}/files/{filename}")
async def download_result_file(job_id: str, filename: str) -> FileResponse:
    allowed = {
        "registration.json",
        "ply_to_pcd_matrix.txt",
        "pcd_to_ply_matrix.txt",
        "ply_to_pcd_cloudcompare_matrix.txt",
        "pcd_to_ply_cloudcompare_matrix.txt",
        "initial_pcd_to_ply_matrix.txt",
        "icp_refinement_pcd_to_ply_matrix.txt",
        "registration.log",
    }
    if filename not in allowed:
        raise HTTPException(status_code=404, detail="File not found")
    path = _job_directory(job_id) / "result" / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(path, filename=filename)


def _web_index() -> Response:
    built_index = STATIC_ROOT / "index.html"
    if built_index.is_file():
        return FileResponse(built_index)
    return HTMLResponse((Path(__file__).parent / "index.html").read_text(encoding="utf-8"))


@app.get("/")
async def index() -> Response:
    return _web_index()


@app.get("/manual-registration/{session_id}")
async def manual_registration_page(session_id: str) -> Response:
    _manual_session_directory(session_id)
    return _web_index()
