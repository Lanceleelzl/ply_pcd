# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import asyncio
import json
import shutil
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import HTTPException


async def run_cleanup_loop(cleanup: Callable[[], None], interval_seconds: float) -> None:
    while True:
        await asyncio.to_thread(cleanup)
        await asyncio.sleep(interval_seconds)


def cleanup_completed_jobs(
    RUNTIME_ROOT: Path,
    RESULT_RETENTION_HOURS: int,
    _job_directory: Callable[[str], Path],
    _read_status: Callable[[Path], dict[str, Any]],
    _v2_source_available: Callable[[Path, dict[str, Any]], bool],
    _release_v2_source_data: Callable[[Path, dict[str, Any]], None],
) -> None:
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


