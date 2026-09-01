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
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel


RUNTIME_ROOT = Path(os.getenv("REGISTRATION_RUNTIME_ROOT", "/data/runtime")).resolve()
WORKER_PATH = os.getenv("REGISTRATION_WORKER_PATH", "/usr/local/bin/registration_worker")
WORKER_TIMEOUT_SECONDS = int(os.getenv("REGISTRATION_WORKER_TIMEOUT_SECONDS", "1800"))
MAX_CONCURRENT_JOBS = int(os.getenv("REGISTRATION_MAX_CONCURRENT_JOBS", "1"))
RESULT_RETENTION_HOURS = int(os.getenv("REGISTRATION_RESULT_RETENTION_HOURS", "168"))
CLEANUP_INTERVAL_SECONDS = int(os.getenv("REGISTRATION_CLEANUP_INTERVAL_SECONDS", "3600"))
UPLOAD_CHUNK_BYTES = 1024 * 1024

app = FastAPI(title="Gaussian PLY / Reference Cloud Registration Service", version="0.2.0")
STATIC_ROOT = Path(__file__).parent / "static"
app.mount("/assets", StaticFiles(directory=STATIC_ROOT / "assets", check_dir=False), name="web-assets")
_job_semaphore = asyncio.Semaphore(MAX_CONCURRENT_JOBS)
_manual_submission_lock = asyncio.Lock()
_background_tasks: set[asyncio.Task[None]] = set()
_running_processes: dict[str, asyncio.subprocess.Process] = {}


class ManualRegistrationRequest(BaseModel):
    initial_pcd_to_ply: list[list[float]]
    precision_mode: str = "recommended"
    min_rms_decrease: float = 1.0e-5
    sampling_limit: int = 50000
    overlap: float = 1.0
    random_seed: int = 42


class ModelRegistrationRequest(BaseModel):
    initial_moving_local_to_fixed_local: list[list[float]]
    output_direction: str = "a_to_b"
    moving_model: str = "auto"
    min_rms_decrease: float = 1.0e-5
    sampling_limit: int = 50000
    overlap: float = 1.0
    random_seed: int = 42
    show_registration_progress: bool = False


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


def _sync_manual_session_job(job_status: dict[str, Any]) -> None:
    session_id = job_status.get("manual_session_id")
    if not session_id:
        return
    session_directory = _manual_session_directory(session_id)
    session_status = _read_status(session_directory)
    registrations = session_status.setdefault("registrations", [])
    entry = next((item for item in registrations if item.get("job_id") == job_status["job_id"]), None)
    if entry is None:
        return
    for field in (
        "status", "started_at_unix", "finished_at_unix", "result_url", "error_code", "error"
    ):
        if field in job_status:
            entry[field] = job_status[field]
    if job_status.get("status") in {"succeeded", "failed", "cancelled"}:
        if session_status.get("active_job_id") == job_status["job_id"]:
            session_status["active_job_id"] = None
    else:
        session_status["active_job_id"] = job_status["job_id"]
    _write_status(session_directory, session_status)


async def _save_upload(upload: UploadFile, destination: Path) -> int:
    total = 0
    with destination.open("wb") as output:
        while chunk := await upload.read(UPLOAD_CHUNK_BYTES):
            output.write(chunk)
            total += len(chunk)
    await upload.close()
    return total


def _reference_extension(upload: UploadFile) -> str:
    suffix = Path(upload.filename or "").suffix.lower()
    if suffix not in {".pcd", ".las", ".laz"}:
        raise HTTPException(status_code=400, detail="reference cloud must use .pcd, .las, or .laz extension")
    return suffix


def _model_extension(upload: UploadFile) -> str:
    suffix = Path(upload.filename or "").suffix.lower()
    if suffix not in {".ply", ".pcd", ".las", ".laz"}:
        raise HTTPException(status_code=400, detail="model must use .ply, .pcd, .las, or .laz extension")
    return suffix


async def _run_worker(job_id: str, command: list[str]) -> None:
    job_directory = _job_directory(job_id)
    async with _job_semaphore:
        status = _read_status(job_directory)
        if status.get("status") == "cancelled":
            shutil.rmtree(job_directory / "input", ignore_errors=True)
            return
        status["status"] = "running"
        status["started_at_unix"] = time.time()
        _write_status(job_directory, status)
        _sync_manual_session_job(status)
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _running_processes[job_id] = process
            if _read_status(job_directory).get("status") == "cancelled":
                process.kill()
            async def read_stdout() -> bytes:
                chunks: list[bytes] = []
                progress_path = job_directory / "progress.ndjson"
                while line := await process.stdout.readline():
                    chunks.append(line)
                    try:
                        event = json.loads(line.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        continue
                    if event.get("type") == "iteration":
                        with progress_path.open("a", encoding="utf-8") as progress_output:
                            progress_output.write(json.dumps(event, separators=(",", ":")) + "\n")
                return b"".join(chunks)
            try:
                stdout, stderr, _ = await asyncio.wait_for(
                    asyncio.gather(read_stdout(), process.stderr.read(), process.wait()),
                    timeout=WORKER_TIMEOUT_SECONDS,
                )
            except asyncio.TimeoutError:
                process.kill()
                await process.communicate()
                status.update(status="failed", error_code="worker_timeout", error="Registration timed out")
                status["finished_at_unix"] = time.time()
                _write_status(job_directory, status)
                _sync_manual_session_job(status)
                shutil.rmtree(job_directory / "input", ignore_errors=True)
                return

            (job_directory / "worker.stdout.log").write_bytes(stdout)
            (job_directory / "worker.stderr.log").write_bytes(stderr)
            current_status = _read_status(job_directory)
            if current_status.get("status") == "cancelled":
                status = current_status
            elif process.returncode != 0:
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
            current_status = _read_status(job_directory)
            if current_status.get("status") == "cancelled":
                status = current_status
            else:
                status.update(status="failed", error_code="worker_start_failed", error=str(error))
        finally:
            _running_processes.pop(job_id, None)
        status["finished_at_unix"] = time.time()
        _write_status(job_directory, status)
        _sync_manual_session_job(status)
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
                *command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=WORKER_TIMEOUT_SECONDS)
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
                        reference_preview_url=f"/api/v1/manual-registration-sessions/{session_id}/preview/reference",
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


async def _run_model_preview(session_id: str, command: list[str]) -> None:
    session_directory = _manual_session_directory(session_id)
    status = _read_status(session_directory)
    async with _job_semaphore:
        status["status"] = "preparing"
        status["started_at_unix"] = time.time()
        _write_status(session_directory, status)
        try:
            process = await asyncio.create_subprocess_exec(
                *command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=WORKER_TIMEOUT_SECONDS)
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
                        model_a_preview_url=f"/api/v2/registration-sessions/{session_id}/preview/model-a",
                        model_b_preview_url=f"/api/v2/registration-sessions/{session_id}/preview/model-b",
                    )
                    if status["metadata"].get("gaussian_a_available"):
                        status["gaussian_a_url"] = f"/api/v2/registration-sessions/{session_id}/preview/gaussian-a"
                    if status["metadata"].get("gaussian_b_available"):
                        status["gaussian_b_url"] = f"/api/v2/registration-sessions/{session_id}/preview/gaussian-b"
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
        if status.get("status") not in {"succeeded", "failed", "cancelled"}:
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
        active_job_id = status.get("active_job_id")
        if active_job_id:
            try:
                if _read_status(_job_directory(active_job_id)).get("status") in {"queued", "running"}:
                    continue
            except HTTPException:
                pass
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
    min_rms_decrease: float, sampling_limit: int, overlap: float, random_seed: int,
    precision_mode: str = "recommended",
) -> None:
    if not 1.0e-8 <= min_rms_decrease <= 1.0e-3:
        raise HTTPException(status_code=400, detail="min_rms_decrease must be between 1e-8 and 1e-3")
    if not 10000 <= sampling_limit <= 500000:
        raise HTTPException(status_code=400, detail="sampling_limit must be between 10000 and 500000")
    if not 0.5 <= overlap <= 1.0:
        raise HTTPException(status_code=400, detail="overlap must be between 0.5 and 1.0")
    if not 0 <= random_seed <= 4294967295:
        raise HTTPException(status_code=400, detail="Invalid registration parameters")
    if precision_mode not in {"recommended", "high_accuracy"}:
        raise HTTPException(status_code=400, detail="precision_mode must be recommended or high_accuracy")


def _validate_initial_matrix(matrix: list[list[float]], field_name: str = "initial_pcd_to_ply") -> None:
    if len(matrix) != 4 or any(len(row) != 4 for row in matrix):
        raise HTTPException(status_code=400, detail=f"{field_name} must be a 4x4 matrix")
    if any(not isinstance(value, (int, float)) or not math.isfinite(value) for row in matrix for value in row):
        raise HTTPException(status_code=400, detail=f"{field_name} must contain only numbers")
    tolerance = 1.0e-5
    if any(abs(matrix[3][column] - (1.0 if column == 3 else 0.0)) > tolerance for column in range(4)):
        raise HTTPException(status_code=400, detail=f"{field_name} must have last row [0, 0, 0, 1]")
    for column in range(3):
        length_squared = sum(matrix[row][column] ** 2 for row in range(3))
        if abs(length_squared - 1.0) > tolerance:
            raise HTTPException(status_code=400, detail=f"{field_name} rotation must not contain scale")
    for left in range(3):
        for right in range(left + 1, 3):
            dot = sum(matrix[row][left] * matrix[row][right] for row in range(3))
            if abs(dot) > tolerance:
                raise HTTPException(status_code=400, detail=f"{field_name} rotation must be orthogonal")
    determinant = (
        matrix[0][0] * (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1])
        - matrix[0][1] * (matrix[1][0] * matrix[2][2] - matrix[1][2] * matrix[2][0])
        + matrix[0][2] * (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0])
    )
    if abs(determinant - 1.0) > tolerance:
        raise HTTPException(status_code=400, detail=f"{field_name} rotation determinant must be +1")


@app.post("/api/v1/manual-registration-sessions", status_code=202)
async def create_manual_registration_session(
    ply: Annotated[UploadFile, File(description="Gaussian Splatting PLY model")],
    pcd: Annotated[UploadFile, File(description="SLAM reference cloud in PCD, LAS, or LAZ format")],
) -> dict[str, Any]:
    if not (ply.filename or "").lower().endswith(".ply"):
        raise HTTPException(status_code=400, detail="ply file must use .ply extension")
    reference_extension = _reference_extension(pcd)
    session_id = str(uuid.uuid4())
    session_directory = _manual_session_directory(session_id)
    input_directory = session_directory / "input"
    preview_directory = session_directory / "preview"
    input_directory.mkdir(parents=True)
    preview_directory.mkdir()
    ply_path = input_directory / "model.ply"
    pcd_path = input_directory / f"reference{reference_extension}"
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
        "inputs": {"ply_bytes": ply_bytes, "pcd_bytes": pcd_bytes, "reference_format": reference_extension[1:]},
        "reference_filename": pcd_path.name,
        "editor_url": f"/manual-registration/{session_id}",
    }
    _write_status(session_directory, status)
    command = [
        WORKER_PATH,
        "prepare-preview",
        "--ply", str(ply_path),
        "--reference", str(pcd_path),
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


@app.post("/api/v2/registration-sessions", status_code=202)
async def create_model_registration_session(
    model_a: Annotated[UploadFile, File(description="Model A: PLY, PCD, LAS, or LAZ")],
    model_b: Annotated[UploadFile, File(description="Model B: PLY, PCD, LAS, or LAZ")],
    output_direction: Annotated[str, Form()] = "a_to_b",
    moving_model: Annotated[str, Form()] = "auto",
) -> dict[str, Any]:
    extension_a = _model_extension(model_a)
    extension_b = _model_extension(model_b)
    if output_direction not in {"a_to_b", "b_to_a"}:
        raise HTTPException(status_code=400, detail="output_direction must be a_to_b or b_to_a")
    if moving_model not in {"auto", "a", "b"}:
        raise HTTPException(status_code=400, detail="moving_model must be auto, a, or b")
    session_id = str(uuid.uuid4())
    session_directory = _manual_session_directory(session_id)
    input_directory = session_directory / "input"
    preview_directory = session_directory / "preview"
    input_directory.mkdir(parents=True)
    preview_directory.mkdir()
    path_a = input_directory / f"model-a{extension_a}"
    path_b = input_directory / f"model-b{extension_b}"
    try:
        bytes_a = await _save_upload(model_a, path_a)
        bytes_b = await _save_upload(model_b, path_b)
        if bytes_a == 0 or bytes_b == 0:
            raise HTTPException(status_code=400, detail="Uploaded files must not be empty")
    except Exception:
        shutil.rmtree(session_directory, ignore_errors=True)
        raise
    status: dict[str, Any] = {
        "session_id": session_id,
        "api_version": "v2",
        "status": "queued",
        "created_at_unix": time.time(),
        "model_a_filename": path_a.name,
        "model_b_filename": path_b.name,
        "output_direction": output_direction,
        "moving_model": moving_model,
        "inputs": {
            "model_a_bytes": bytes_a, "model_b_bytes": bytes_b,
            "model_a_format": extension_a[1:], "model_b_format": extension_b[1:],
        },
        "editor_url": f"/?session={session_id}&api=v2",
    }
    _write_status(session_directory, status)
    command = [
        WORKER_PATH, "prepare-model-preview",
        "--model-a", str(path_a), "--model-b", str(path_b),
        "--output-dir", str(preview_directory),
        "--model-a-limit", "300000", "--model-b-limit", "300000",
    ]
    task = asyncio.create_task(_run_model_preview(session_id, command))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return {
        "session_id": session_id, "status": "queued",
        "status_url": f"/api/v2/registration-sessions/{session_id}",
        "editor_url": status["editor_url"],
    }


@app.get("/api/v2/registration-sessions/{session_id}")
async def get_model_registration_session(session_id: str) -> dict[str, Any]:
    status = _read_status(_manual_session_directory(session_id))
    if status.get("api_version") != "v2":
        raise HTTPException(status_code=404, detail="V2 registration session not found")
    return status


@app.get("/api/v2/registration-sessions/{session_id}/preview/{model}")
async def get_model_registration_preview(session_id: str, model: str) -> FileResponse:
    session_directory = _manual_session_directory(session_id)
    status = _read_status(session_directory)
    if status.get("api_version") != "v2":
        raise HTTPException(status_code=404, detail="V2 registration session not found")
    if model == "model-a":
        path = session_directory / "preview" / "model-a-points.bin"
        filename = "model-a-points.bin"
    elif model == "model-b":
        path = session_directory / "preview" / "model-b-points.bin"
        filename = "model-b-points.bin"
    elif model == "gaussian-a" and status.get("metadata", {}).get("gaussian_a_available"):
        path = session_directory / "input" / status["model_a_filename"]
        filename = status["model_a_filename"]
    elif model == "gaussian-b" and status.get("metadata", {}).get("gaussian_b_available"):
        path = session_directory / "input" / status["model_b_filename"]
        filename = status["model_b_filename"]
    else:
        raise HTTPException(status_code=404, detail="Preview not found")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Preview not found")
    return FileResponse(path, media_type="application/octet-stream", filename=filename)


@app.post("/api/v2/registration-sessions/{session_id}/register", status_code=202)
async def register_model_session(session_id: str, request: ModelRegistrationRequest) -> dict[str, Any]:
    _validate_initial_matrix(
        request.initial_moving_local_to_fixed_local, "initial_moving_local_to_fixed_local"
    )
    _validate_registration_parameters(
        request.min_rms_decrease, request.sampling_limit, request.overlap, request.random_seed,
    )
    if request.output_direction not in {"a_to_b", "b_to_a"}:
        raise HTTPException(status_code=400, detail="output_direction must be a_to_b or b_to_a")
    if request.moving_model not in {"auto", "a", "b"}:
        raise HTTPException(status_code=400, detail="moving_model must be auto, a, or b")
    async with _manual_submission_lock:
        session_directory = _manual_session_directory(session_id)
        session_status = _read_status(session_directory)
        if session_status.get("api_version") != "v2":
            raise HTTPException(status_code=404, detail="V2 registration session not found")
        if session_status.get("status") != "ready":
            raise HTTPException(status_code=409, detail=f"Session status is {session_status.get('status')}")
        active_job_id = session_status.get("active_job_id")
        if active_job_id:
            try:
                if _read_status(_job_directory(active_job_id)).get("status") in {"queued", "running"}:
                    raise HTTPException(status_code=409, detail="Session already has an active registration")
            except HTTPException as error:
                if error.status_code == 409:
                    raise
        job_id = str(uuid.uuid4())
        job_directory = _job_directory(job_id)
        input_directory = job_directory / "input"
        result_directory = job_directory / "result"
        input_directory.mkdir(parents=True)
        result_directory.mkdir()
        matrix_path = input_directory / "initial_moving_local_to_fixed_local.txt"
        matrix_path.write_text(
            "\n".join(" ".join(f"{value:.17g}" for value in row)
                      for row in request.initial_moving_local_to_fixed_local) + "\n",
            encoding="utf-8",
        )
        status = {
            "job_id": job_id, "status": "queued", "created_at_unix": time.time(),
            "manual_session_id": session_id, "inputs": session_status["inputs"],
        }
        _write_status(job_directory, status)
        session_status.setdefault("registrations", []).append({
            "job_id": job_id, "status": "queued", "created_at_unix": status["created_at_unix"],
            "initial_moving_local_to_fixed_local": request.initial_moving_local_to_fixed_local,
            "output_direction": request.output_direction, "moving_model": request.moving_model,
            "parameters": {
                "min_rms_decrease": request.min_rms_decrease,
                "sampling_limit": request.sampling_limit,
                "overlap": request.overlap,
                "random_seed": request.random_seed,
            },
            "status_url": f"/api/v1/registrations/{job_id}",
            "progress_url": f"/api/v1/registrations/{job_id}/events",
        })
        session_status["active_job_id"] = job_id
        session_status["output_direction"] = request.output_direction
        session_status["moving_model"] = request.moving_model
        _write_status(session_directory, session_status)
    command = [
        WORKER_PATH, "register-models",
        "--model-a", str(session_directory / "input" / session_status["model_a_filename"]),
        "--model-b", str(session_directory / "input" / session_status["model_b_filename"]),
        "--moving-model", request.moving_model,
        "--output-direction", request.output_direction,
        "--initial-matrix", str(matrix_path), "--output-dir", str(result_directory),
        "--min-rms-decrease", str(request.min_rms_decrease),
        "--sampling-limit", str(request.sampling_limit), "--overlap", str(request.overlap),
        "--random-seed", str(request.random_seed),
    ]
    command.append("--progress-jsonl")
    task = asyncio.create_task(_run_worker(job_id, command))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return {
        "job_id": job_id,
        "status": "queued",
        "status_url": f"/api/v1/registrations/{job_id}",
        "progress_url": f"/api/v1/registrations/{job_id}/events",
    }


@app.get("/api/v1/manual-registration-sessions/{session_id}")
async def get_manual_registration_session(session_id: str) -> dict[str, Any]:
    return _read_status(_manual_session_directory(session_id))


@app.get("/api/v1/manual-registration-sessions/{session_id}/preview/{cloud}")
async def get_manual_registration_preview(session_id: str, cloud: str) -> FileResponse:
    filenames = {
        "ply": "ply-points.bin",
        "pcd": "pcd-points.bin",
        "reference": "pcd-points.bin",
    }
    if cloud == "gaussian":
        path = _manual_session_directory(session_id) / "input" / "model.ply"
        filename = "original-gaussian-model.ply"
    elif cloud in filenames:
        path = _manual_session_directory(session_id) / "preview" / filenames[cloud]
        filename = filenames[cloud]
    else:
        raise HTTPException(status_code=404, detail="Preview not found")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Preview not found")
    media_type = "application/octet-stream" if cloud != "gaussian" else "application/ply"
    return FileResponse(path, media_type=media_type, filename=filename)


@app.post("/api/v1/manual-registration-sessions/{session_id}/register", status_code=202)
async def register_manual_session(
    session_id: str, request: ManualRegistrationRequest
) -> dict[str, Any]:
    _validate_initial_matrix(request.initial_pcd_to_ply)
    _validate_registration_parameters(
        request.min_rms_decrease, request.sampling_limit, request.overlap, request.random_seed,
        request.precision_mode,
    )
    async with _manual_submission_lock:
        session_directory = _manual_session_directory(session_id)
        session_status = _read_status(session_directory)
        if session_status.get("status") != "ready":
            raise HTTPException(status_code=409, detail=f"Manual session status is {session_status.get('status')}")
        active_job_id = session_status.get("active_job_id")
        if active_job_id:
            try:
                active_status = _read_status(_job_directory(active_job_id)).get("status")
            except HTTPException:
                active_status = None
            if active_status in {"queued", "running"}:
                raise HTTPException(status_code=409, detail="Manual session already has an active registration")
            session_status["active_job_id"] = None
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
        session_status.setdefault("registrations", []).append({
            "job_id": job_id,
            "status": "queued",
            "created_at_unix": status["created_at_unix"],
            "initial_pcd_to_ply": request.initial_pcd_to_ply,
            "precision_mode": request.precision_mode,
            "parameters": {
                "min_rms_decrease": request.min_rms_decrease,
                "sampling_limit": request.sampling_limit,
                "overlap": request.overlap,
                "random_seed": request.random_seed,
            },
            "status_url": f"/api/v1/registrations/{job_id}",
        })
        session_status["active_job_id"] = job_id
        _write_status(session_directory, session_status)
    command = [
        WORKER_PATH,
        "register",
        "--ply", str(session_directory / "input" / "model.ply"),
        "--reference", str(session_directory / "input" / session_status["reference_filename"]),
        "--initial-matrix", str(matrix_path),
        "--output-dir", str(result_directory),
        "--min-rms-decrease", str(request.min_rms_decrease),
        "--sampling-limit", str(request.sampling_limit),
        "--overlap", str(request.overlap),
        "--random-seed", str(request.random_seed),
        "--precision-mode", request.precision_mode,
    ]
    task = asyncio.create_task(_run_worker(job_id, command))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return {"job_id": job_id, "status": "queued", "status_url": f"/api/v1/registrations/{job_id}"}


@app.post("/api/v1/registrations", status_code=202)
async def create_registration(
    ply: Annotated[UploadFile, File(description="Gaussian Splatting PLY model")],
    pcd: Annotated[UploadFile, File(description="SLAM reference cloud in PCD, LAS, or LAZ format")],
    min_rms_decrease: Annotated[float, Form()] = 1.0e-5,
    sampling_limit: Annotated[int, Form()] = 50000,
    overlap: Annotated[float, Form()] = 1.0,
    random_seed: Annotated[int, Form()] = 42,
    precision_mode: Annotated[str, Form()] = "recommended",
) -> dict[str, Any]:
    if not (ply.filename or "").lower().endswith(".ply"):
        raise HTTPException(status_code=400, detail="ply file must use .ply extension")
    reference_extension = _reference_extension(pcd)
    _validate_registration_parameters(min_rms_decrease, sampling_limit, overlap, random_seed, precision_mode)

    job_id = str(uuid.uuid4())
    job_directory = _job_directory(job_id)
    input_directory = job_directory / "input"
    result_directory = job_directory / "result"
    input_directory.mkdir(parents=True)
    result_directory.mkdir()
    ply_path = input_directory / "model.ply"
    pcd_path = input_directory / f"reference{reference_extension}"
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
        "inputs": {"ply_bytes": ply_bytes, "pcd_bytes": pcd_bytes, "reference_format": reference_extension[1:]},
    }
    _write_status(job_directory, status)
    command = [
        WORKER_PATH,
        "register",
        "--ply", str(ply_path),
        "--reference", str(pcd_path),
        "--output-dir", str(result_directory),
        "--min-rms-decrease", str(min_rms_decrease),
        "--sampling-limit", str(sampling_limit),
        "--overlap", str(overlap),
        "--random-seed", str(random_seed),
        "--precision-mode", precision_mode,
    ]
    task = asyncio.create_task(_run_worker(job_id, command))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return {"job_id": job_id, "status": "queued", "status_url": f"/api/v1/registrations/{job_id}"}


@app.get("/api/v1/registrations/{job_id}")
async def get_registration(job_id: str) -> dict[str, Any]:
    return _read_status(_job_directory(job_id))


@app.get("/api/v1/registrations/{job_id}/events")
async def stream_registration_events(job_id: str, from_latest: bool = False) -> StreamingResponse:
    job_directory = _job_directory(job_id)
    _read_status(job_directory)

    async def event_stream():
        offset = 0
        heartbeat = 0
        if from_latest:
            progress_path = job_directory / "progress.ndjson"
            if progress_path.is_file():
                with progress_path.open("r", encoding="utf-8") as progress_input:
                    lines = [line.strip() for line in progress_input.read().splitlines() if line.strip()]
                    offset = progress_input.tell()
                if lines:
                    yield f"event: iteration\ndata: {lines[-1]}\n\n"
        while True:
            progress_path = job_directory / "progress.ndjson"
            if progress_path.is_file():
                with progress_path.open("r", encoding="utf-8") as progress_input:
                    progress_input.seek(offset)
                    for line in progress_input:
                        yield f"event: iteration\ndata: {line.strip()}\n\n"
                    offset = progress_input.tell()
            status = _read_status(job_directory)
            if status.get("status") in {"succeeded", "failed", "cancelled"}:
                payload = json.dumps({"status": status["status"]}, separators=(",", ":"))
                yield f"event: terminal\ndata: {payload}\n\n"
                break
            heartbeat += 1
            if heartbeat % 20 == 0:
                yield ": keep-alive\n\n"
            await asyncio.sleep(0.25)

    return StreamingResponse(
        event_stream(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/v1/registrations/{job_id}/cancel")
async def cancel_registration(job_id: str) -> dict[str, Any]:
    job_directory = _job_directory(job_id)
    status = _read_status(job_directory)
    if status.get("status") == "cancelled":
        return status
    if status.get("status") not in {"queued", "running"}:
        raise HTTPException(status_code=409, detail=f"Job status is {status.get('status')}")
    status.update(
        status="cancelled",
        error_code="task_cancelled",
        error="Registration cancelled by user",
        finished_at_unix=time.time(),
    )
    _write_status(job_directory, status)
    _sync_manual_session_job(status)
    process = _running_processes.get(job_id)
    if process is not None and process.returncode is None:
        process.kill()
    if process is None:
        shutil.rmtree(job_directory / "input", ignore_errors=True)
    return status


@app.get("/api/v1/registrations/{job_id}/result")
async def get_registration_result(job_id: str) -> dict[str, Any]:
    job_directory = _job_directory(job_id)
    status = _read_status(job_directory)
    if status["status"] != "succeeded":
        raise HTTPException(status_code=409, detail=f"Job status is {status['status']}")
    result = json.loads((job_directory / "result" / "registration.json").read_text(encoding="utf-8"))
    if "a_to_b" in result and "b_to_a" in result:
        return result
    return {
        "recommended_matrix": {
            "name": "T_ply_to_reference",
            "direction": "PLY_TO_REFERENCE_WORLD",
            "formula": "p_reference_world = T_ply_to_reference * p_ply",
            "usage": "Use this matrix to transform Gaussian PLY points into the SLAM reference cloud world coordinate system.",
            "value": result["ply_to_reference"],
            "cloudcompare_value": result["ply_to_reference_cloudcompare"],
        },
        **result,
    }


@app.get("/api/v1/registrations/{job_id}/files/{filename}")
async def download_result_file(job_id: str, filename: str) -> FileResponse:
    allowed = {
        "registration.json",
        "ply_to_reference_matrix.txt",
        "reference_to_ply_matrix.txt",
        "reference_local_to_ply_matrix.txt",
        "initial_reference_local_to_ply_matrix.txt",
        "icp_refinement_reference_local_to_ply_matrix.txt",
        "a_to_b_matrix.txt",
        "b_to_a_matrix.txt",
        "moving_local_to_fixed_local_matrix.txt",
        "initial_moving_local_to_fixed_local_matrix.txt",
        "icp_refinement_moving_local_to_fixed_local_matrix.txt",
        "ply_to_reference_cloudcompare_matrix.txt",
        "reference_to_ply_cloudcompare_matrix.txt",
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
