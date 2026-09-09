# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import asyncio
import json
import shutil
import time
import uuid
from pathlib import Path
from typing import Annotated, Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from service.background_tasks import BackgroundTasks
from service.config import (
    CLEANUP_INTERVAL_SECONDS,
    MAX_CONCURRENT_JOBS,
    RESULT_RETENTION_HOURS,
    RUNTIME_ROOT,
    SERVICE_VERSION,
    SOURCE_RETENTION_HOURS,
    WORKER_PATH,
    WORKER_TIMEOUT_SECONDS,
)
from service.schemas import (
    ManualRegistrationRequest,
    ModelRegistrationRequest,
    TransformParameters,
    WorkspaceRequest,
)
from service.routes.history import create_history_router
from service.routes.jobs import create_job_router
from service.routes.sessions import create_session_router
from service.routes.web import create_web_router
from service.preview_tasks import run_preview_task
from service.registration_tasks import run_registration_task
from service.storage import (
    history_directory as _storage_history_directory,
    history_path as _storage_history_path,
    job_directory as _storage_job_directory,
    read_status as _storage_read_status,
    session_directory as _storage_session_directory,
    status_path as _storage_status_path,
    workspace_id as _storage_workspace_id,
    write_status as _storage_write_status,
)
from service.transform_math import (
    business_transforms as _business_transforms,
    inverse_affine as _inverse_affine,
    matmul as _matmul,
    transform_matrix as _transform_matrix,
)
from service.validation import (
    model_extension as _model_extension,
    reference_extension as _reference_extension,
    validate_initial_matrix as _validate_initial_matrix,
    validate_registration_parameters as _validate_registration_parameters,
    validate_transform as _validate_transform,
)
from service.uploads import save_upload as _save_upload, save_upload_with_sha256 as _save_upload_with_sha256

app = FastAPI(title="Gaussian PLY / Reference Cloud Registration Service", version=SERVICE_VERSION)
STATIC_ROOT = Path(__file__).parent / "static"
app.mount("/assets", StaticFiles(directory=STATIC_ROOT / "assets", check_dir=False), name="web-assets")
_job_semaphore = asyncio.Semaphore(MAX_CONCURRENT_JOBS)
_manual_submission_lock = asyncio.Lock()
_background_tasks = BackgroundTasks()
_running_processes: dict[str, asyncio.subprocess.Process] = {}


def _job_directory(job_id: str) -> Path:
    return _storage_job_directory(RUNTIME_ROOT, job_id)


def _manual_session_directory(session_id: str) -> Path:
    return _storage_session_directory(RUNTIME_ROOT, session_id)


def _workspace_id(value: str) -> str:
    return _storage_workspace_id(value)


def _history_directory(workspace_id: str) -> Path:
    return _storage_history_directory(RUNTIME_ROOT, workspace_id)


def _status_path(job_directory: Path) -> Path:
    return _storage_status_path(job_directory)


def _write_status(job_directory: Path, status: dict[str, Any]) -> None:
    _storage_write_status(job_directory, status)


def _read_status(job_directory: Path) -> dict[str, Any]:
    return _storage_read_status(job_directory)


def _v2_source_available(session_directory: Path, status: dict[str, Any]) -> bool:
    return all(
        (session_directory / "input" / status.get(field, "")).is_file()
        for field in ("model_a_filename", "model_b_filename")
    )


def _history_path(workspace_id: str, session_id: str) -> Path:
    return _storage_history_path(RUNTIME_ROOT, workspace_id, session_id)


app.include_router(create_web_router(STATIC_ROOT, _manual_session_directory, _read_status))


def _write_v2_history(session_directory: Path, session_status: dict[str, Any]) -> dict[str, Any] | None:
    workspace_id = session_status.get("workspace_id")
    if session_status.get("api_version") != "v2" or not workspace_id:
        return None
    completed = [entry for entry in session_status.get("registrations", []) if entry.get("status") == "succeeded"]
    if not completed:
        return None
    latest = max(completed, key=lambda entry: float(entry.get("finished_at_unix", 0)))
    job_id = latest.get("job_id")
    if not job_id:
        return None
    result_path = _job_directory(job_id) / "result" / "registration.json"
    if not result_path.is_file():
        existing = _history_path(workspace_id, session_status["session_id"])
        return json.loads(existing.read_text(encoding="utf-8")) if existing.is_file() else None
    result = json.loads(result_path.read_text(encoding="utf-8"))
    metadata = session_status.get("metadata", {}).get("models", {})
    inputs = session_status.get("inputs", {})
    record = {
        "session_id": session_status["session_id"],
        "workspace_id": workspace_id,
        "status": "succeeded",
        "created_at_unix": session_status.get("created_at_unix"),
        "completed_at_unix": latest.get("finished_at_unix"),
        "source_expires_at_unix": session_status.get("source_expires_at_unix"),
        "service_version": SERVICE_VERSION,
        "output_direction": latest.get("output_direction", session_status.get("output_direction")),
        "moving_model": latest.get("moving_model", session_status.get("moving_model")),
        "models": {
            "a": {
                "filename": inputs.get("model_a_original_filename", session_status.get("model_a_filename")),
                "format": inputs.get("model_a_format"), "bytes": inputs.get("model_a_bytes"),
                "sha256": inputs.get("model_a_sha256"), "point_count": metadata.get("a", {}).get("source_point_count"),
            },
            "b": {
                "filename": inputs.get("model_b_original_filename", session_status.get("model_b_filename")),
                "format": inputs.get("model_b_format"), "bytes": inputs.get("model_b_bytes"),
                "sha256": inputs.get("model_b_sha256"), "point_count": metadata.get("b", {}).get("source_point_count"),
            },
        },
        "parameters": latest.get("parameters", result.get("parameters", {})),
        "recommended_matrix": result.get("recommended_matrix"),
        "a_to_b": result.get("a_to_b"), "b_to_a": result.get("b_to_a"),
        "file_a_to_b": result.get("file_a_to_b"), "file_b_to_a": result.get("file_b_to_a"),
        "business_transforms": result.get("business_transforms", session_status.get("business_transforms")),
        "metrics": result.get("metrics", {}),
    }
    directory = _history_directory(workspace_id)
    directory.mkdir(parents=True, exist_ok=True)
    path = _history_path(workspace_id, session_status["session_id"])
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)
    return record


def _release_v2_source_data(session_directory: Path, session_status: dict[str, Any]) -> None:
    active_job_id = session_status.get("active_job_id")
    if active_job_id:
        try:
            if _read_status(_job_directory(active_job_id)).get("status") in {"queued", "running"}:
                raise HTTPException(status_code=409, detail="Active registration must finish or be cancelled first")
        except HTTPException as error:
            if error.status_code == 409:
                raise
    _write_v2_history(session_directory, session_status)
    shutil.rmtree(session_directory / "input", ignore_errors=True)
    shutil.rmtree(session_directory / "preview", ignore_errors=True)
    for filename in ("worker.stdout.log", "worker.stderr.log"):
        (session_directory / filename).unlink(missing_ok=True)
    for entry in session_status.get("registrations", []):
        job_id = entry.get("job_id")
        if not job_id:
            continue
        job_directory = _job_directory(job_id)
        try:
            job_status = _read_status(job_directory)
        except HTTPException:
            continue
        if job_status.get("status") in {"succeeded", "failed", "cancelled"}:
            shutil.rmtree(job_directory)
    session_status["source_released_at_unix"] = time.time()
    session_status["source_available"] = False
    _write_status(session_directory, session_status)


def _history_view(record: dict[str, Any]) -> dict[str, Any]:
    session_directory = _manual_session_directory(record["session_id"])
    try:
        status = _read_status(session_directory)
        source_available = _v2_source_available(session_directory, status)
        source_expires = status.get("source_expires_at_unix")
    except (HTTPException, OSError, json.JSONDecodeError):
        source_available = False
        source_expires = record.get("source_expires_at_unix")
    return {
        **record,
        "source_available": source_available,
        "restartable": source_available,
        "source_expires_at_unix": source_expires,
    }


app.include_router(create_history_router(_history_directory, _history_path, _history_view, _workspace_id))
app.include_router(create_session_router(
    _manual_session_directory,
    _job_directory,
    _read_status,
    _write_status,
    _v2_source_available,
    _workspace_id,
    _validate_transform,
    _write_v2_history,
    _release_v2_source_data,
    SOURCE_RETENTION_HOURS,
))


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
    if job_status.get("status") == "succeeded" and session_status.get("api_version") == "v2":
        try:
            _write_v2_history(session_directory, session_status)
        except (OSError, ValueError, json.JSONDecodeError):
            pass


app.include_router(create_job_router(
    _job_directory, _read_status, _write_status, _sync_manual_session_job, _running_processes,
))


async def _run_worker(job_id: str, command: list[str]) -> None:
    await run_registration_task(
        job_id, command,
        resolve_job_directory=_job_directory,
        session_directory=_manual_session_directory,
        read_status=_read_status,
        write_status=_write_status,
        sync_session_job=_sync_manual_session_job,
        semaphore=_job_semaphore,
        running_processes=_running_processes,
        timeout_seconds=WORKER_TIMEOUT_SECONDS,
    )


async def _run_preview(session_id: str, command: list[str]) -> None:
    await run_preview_task(
        session_id, command, "manual", _manual_session_directory, _read_status, _write_status,
        _job_semaphore, WORKER_TIMEOUT_SECONDS,
    )


async def _run_model_preview(session_id: str, command: list[str]) -> None:
    await run_preview_task(
        session_id, command, "models", _manual_session_directory, _read_status, _write_status,
        _job_semaphore, WORKER_TIMEOUT_SECONDS,
    )


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
        source_expires = status.get("source_expires_at_unix")
        if (
            status.get("api_version") == "v2"
            and source_expires is not None
            and _v2_source_available(session_directory, status)
            and float(source_expires) <= time.time()
        ):
            try:
                _release_v2_source_data(session_directory, status)
            except (HTTPException, OSError, ValueError, json.JSONDecodeError):
                continue
            continue
        if float(status.get("updated_at_unix", 0)) < expires_before:
            shutil.rmtree(session_directory)


async def _cleanup_loop() -> None:
    while True:
        await asyncio.to_thread(_cleanup_completed_jobs)
        await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)


@app.on_event("startup")
async def start_cleanup() -> None:
    _background_tasks.start(_cleanup_loop())


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
    _background_tasks.start(_run_preview(session_id, command))
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
    workspace_id: Annotated[str, Form()] = "",
    model_a_transform: Annotated[str, Form()] = "",
    model_b_transform: Annotated[str, Form()] = "",
) -> dict[str, Any]:
    extension_a = _model_extension(model_a)
    extension_b = _model_extension(model_b)
    if output_direction not in {"a_to_b", "b_to_a"}:
        raise HTTPException(status_code=400, detail="output_direction must be a_to_b or b_to_a")
    if moving_model not in {"auto", "a", "b"}:
        raise HTTPException(status_code=400, detail="moving_model must be auto, a, or b")
    workspace_id = _workspace_id(workspace_id) if workspace_id else str(uuid.uuid4())
    default_transform = TransformParameters()
    try:
        transform_a = TransformParameters.model_validate_json(model_a_transform) if model_a_transform else default_transform
        transform_b = TransformParameters.model_validate_json(model_b_transform) if model_b_transform else default_transform
    except Exception as error:
        raise HTTPException(status_code=400, detail=f"Invalid business transform: {error}") from error
    _validate_transform(transform_a); _validate_transform(transform_b)
    session_id = str(uuid.uuid4())
    session_directory = _manual_session_directory(session_id)
    input_directory = session_directory / "input"
    preview_directory = session_directory / "preview"
    input_directory.mkdir(parents=True)
    preview_directory.mkdir()
    path_a = input_directory / f"model-a{extension_a}"
    path_b = input_directory / f"model-b{extension_b}"
    try:
        (bytes_a, sha256_a), (bytes_b, sha256_b) = await asyncio.gather(
            _save_upload_with_sha256(model_a, path_a),
            _save_upload_with_sha256(model_b, path_b),
        )
        if bytes_a == 0 or bytes_b == 0:
            raise HTTPException(status_code=400, detail="Uploaded files must not be empty")
    except Exception:
        shutil.rmtree(session_directory, ignore_errors=True)
        raise
    status: dict[str, Any] = {
        "session_id": session_id,
        "api_version": "v2",
        "workspace_id": workspace_id,
        "status": "queued",
        "created_at_unix": time.time(),
        "source_expires_at_unix": time.time() + SOURCE_RETENTION_HOURS * 3600,
        "model_a_filename": path_a.name,
        "model_b_filename": path_b.name,
        "output_direction": output_direction,
        "moving_model": moving_model,
        "business_transforms": {"a": transform_a.model_dump(), "b": transform_b.model_dump()},
        "inputs": {
            "model_a_bytes": bytes_a, "model_b_bytes": bytes_b,
            "model_a_format": extension_a[1:], "model_b_format": extension_b[1:],
            "model_a_original_filename": Path(model_a.filename or path_a.name).name,
            "model_b_original_filename": Path(model_b.filename or path_b.name).name,
            "model_a_sha256": sha256_a, "model_b_sha256": sha256_b,
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
    _background_tasks.start(_run_model_preview(session_id, command))
    return {
        "session_id": session_id, "workspace_id": workspace_id, "status": "queued",
        "status_url": f"/api/v2/registration-sessions/{session_id}",
        "editor_url": status["editor_url"],
    }


@app.post("/api/v2/registration-sessions/{session_id}/resume", status_code=202)
async def resume_model_registration_session(session_id: str, request: WorkspaceRequest) -> dict[str, Any]:
    session_directory = _manual_session_directory(session_id)
    status = _read_status(session_directory)
    if status.get("api_version") != "v2" or status.get("workspace_id") != _workspace_id(request.workspace_id):
        raise HTTPException(status_code=404, detail="V2 registration session not found")
    if not _v2_source_available(session_directory, status):
        raise HTTPException(status_code=409, detail="Source model files have been cleaned")
    preview_directory = session_directory / "preview"
    preview_ready = all((preview_directory / name).is_file() for name in ("model-a-points.bin", "model-b-points.bin"))
    if preview_ready and status.get("status") == "ready":
        return {"session_id": session_id, "status": "ready", "editor_url": status["editor_url"]}
    if status.get("status") in {"queued", "preparing"}:
        return {"session_id": session_id, "status": status["status"], "editor_url": status["editor_url"]}
    preview_directory.mkdir(parents=True, exist_ok=True)
    status["status"] = "queued"
    status.pop("error", None)
    status.pop("error_code", None)
    _write_status(session_directory, status)
    command = [
        WORKER_PATH, "prepare-model-preview",
        "--model-a", str(session_directory / "input" / status["model_a_filename"]),
        "--model-b", str(session_directory / "input" / status["model_b_filename"]),
        "--output-dir", str(preview_directory),
        "--model-a-limit", "300000", "--model-b-limit", "300000",
    ]
    _background_tasks.start(_run_model_preview(session_id, command))
    return {"session_id": session_id, "status": "queued", "editor_url": status["editor_url"]}


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
    if request.coordinate_space not in {"file", "business"}:
        raise HTTPException(status_code=400, detail="coordinate_space must be file or business")
    async with _manual_submission_lock:
        session_directory = _manual_session_directory(session_id)
        session_status = _read_status(session_directory)
        if session_status.get("api_version") != "v2":
            raise HTTPException(status_code=404, detail="V2 registration session not found")
        if not _v2_source_available(session_directory, session_status):
            raise HTTPException(status_code=409, detail="Source model files have been cleaned")
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
            "coordinate_space": request.coordinate_space,
        }
        _write_status(job_directory, status)
        session_status.setdefault("registrations", []).append({
            "job_id": job_id, "status": "queued", "created_at_unix": status["created_at_unix"],
            "initial_moving_local_to_fixed_local": request.initial_moving_local_to_fixed_local,
            "output_direction": request.output_direction, "moving_model": request.moving_model,
            "coordinate_space": request.coordinate_space,
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
    if request.coordinate_space == "business":
        transforms = _business_transforms(session_status)
        for model in ("a", "b"):
            path = input_directory / f"model_{model}_to_business.txt"
            path.write_text("\n".join(" ".join(f"{value:.17g}" for value in row)
                                      for row in _transform_matrix(transforms[model])) + "\n", encoding="utf-8")
            command.extend([f"--model-{model}-to-business", str(path)])
    command.append("--progress-jsonl")
    _background_tasks.start(_run_worker(job_id, command))
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
    _background_tasks.start(_run_worker(job_id, command))
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
    _background_tasks.start(_run_worker(job_id, command))
    return {"job_id": job_id, "status": "queued", "status_url": f"/api/v1/registrations/{job_id}"}
