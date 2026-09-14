# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from service.background_tasks import BackgroundTasks
from service.history import write_history, release_source_data, history_view
from service.cleanup import cleanup_completed_jobs, run_cleanup_loop
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
    TransformParameters,
)
from service.routes.history import create_history_router
from service.routes.jobs import create_job_router
from service.routes.registrations import create_registration_router
from service.routes.sessions import create_session_router
from service.routes.web import create_web_router
from service.routes.uploads import create_upload_router
from service.preview_tasks import run_preview_task
from service.registration_tasks import run_registration_task
from service.session_state import normalize_task_links, source_available, sync_session_job
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
    validate_transform as _validate_transform,
)

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
    return normalize_task_links(_storage_read_status(job_directory))


def _v2_source_available(session_directory: Path, status: dict[str, Any]) -> bool:
    return source_available(session_directory, status)


def _history_path(workspace_id: str, session_id: str) -> Path:
    return _storage_history_path(RUNTIME_ROOT, workspace_id, session_id)


app.include_router(create_web_router(STATIC_ROOT, _manual_session_directory, _read_status))


def _write_v2_history(session_directory: Path, session_status: dict[str, Any]) -> dict[str, Any] | None:
    return write_history(session_directory, session_status, _job_directory=_job_directory, _history_path=_history_path, _history_directory=_history_directory, SERVICE_VERSION=SERVICE_VERSION)


def _release_v2_source_data(session_directory: Path, session_status: dict[str, Any]) -> None:
    return release_source_data(session_directory, session_status, _job_directory=_job_directory, _read_status=_read_status, _write_status=_write_status, _write_v2_history=_write_v2_history)


def _history_view(record: dict[str, Any]) -> dict[str, Any]:
    return history_view(record, _manual_session_directory=_manual_session_directory, _read_status=_read_status, _v2_source_available=_v2_source_available)


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
    WORKER_PATH,
    lambda session_id, command: _background_tasks.start(_run_model_preview(session_id, command)),
))


def _sync_manual_session_job(job_status: dict[str, Any]) -> None:
    sync_session_job(
        job_status,
        resolve_session_directory=_manual_session_directory,
        read_status=_read_status,
        write_status=_write_status,
        write_history=_write_v2_history,
    )


app.include_router(create_job_router(
    _job_directory, _read_status, _write_status, _sync_manual_session_job, _running_processes,
))


app.include_router(create_registration_router(
    _manual_session_directory, _job_directory, _read_status, _write_status,
    _v2_source_available, _manual_submission_lock, WORKER_PATH,
    lambda job_id, command: _background_tasks.start(_run_worker(job_id, command)),
))


app.include_router(create_upload_router(
    _manual_session_directory, _write_status, WORKER_PATH, SOURCE_RETENTION_HOURS,
    lambda session_id, command: _background_tasks.start(_run_model_preview(session_id, command)),
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


async def _run_model_preview(session_id: str, command: list[str]) -> None:
    await run_preview_task(
        session_id, command, _manual_session_directory, _read_status, _write_status,
        _job_semaphore, WORKER_TIMEOUT_SECONDS,
    )


def _cleanup_completed_jobs() -> None:
    cleanup_completed_jobs(
        RUNTIME_ROOT, RESULT_RETENTION_HOURS, _job_directory, _read_status,
        _v2_source_available, _release_v2_source_data,
    )


async def _cleanup_loop() -> None:
    await run_cleanup_loop(_cleanup_completed_jobs, CLEANUP_INTERVAL_SECONDS)


@app.on_event("startup")
async def start_cleanup() -> None:
    _background_tasks.start(_cleanup_loop())
