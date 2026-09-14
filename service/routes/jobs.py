# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import asyncio
import json
import shutil
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, StreamingResponse


def create_job_router(
    _job_directory: Callable[[str], Path],
    _read_status: Callable[[Path], dict[str, Any]],
    _write_status: Callable[[Path, dict[str, Any]], None],
    _sync_manual_session_job: Callable[[dict[str, Any]], None],
    _running_processes: dict[str, asyncio.subprocess.Process],
    restore_result: Callable[[str, str, Path], bool],
) -> APIRouter:
    router = APIRouter()

    @router.get("/api/v2/registrations/{job_id}")
    async def get_registration(job_id: str) -> dict[str, Any]:
        return _read_status(_job_directory(job_id))


    @router.get("/api/v2/registrations/{job_id}/events")
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


    @router.post("/api/v2/registrations/{job_id}/cancel")
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


    @router.get("/api/v2/registrations/{job_id}/result")
    async def get_registration_result(job_id: str) -> dict[str, Any]:
        job_directory = _job_directory(job_id)
        status = _read_status(job_directory)
        if status["status"] != "succeeded":
            raise HTTPException(status_code=409, detail=f"Job status is {status['status']}")
        path = job_directory / "result" / "registration.json"
        if not path.is_file():
            try:
                restored = await asyncio.to_thread(restore_result, job_id, "registration.json", path)
            except Exception as error:
                raise HTTPException(status_code=502, detail="Stored result is unavailable") from error
            if not restored:
                raise HTTPException(status_code=404, detail="Result not found")
        result = json.loads(path.read_text(encoding="utf-8"))
        return result


    @router.get("/api/v2/registrations/{job_id}/files/{filename}")
    async def download_result_file(job_id: str, filename: str) -> FileResponse:
        allowed = {
            "registration.json",
            "a_to_b_matrix.txt",
            "b_to_a_matrix.txt",
            "file_a_to_b_matrix.txt",
            "file_b_to_a_matrix.txt",
            "moving_local_to_fixed_local_matrix.txt",
            "initial_moving_local_to_fixed_local_matrix.txt",
            "icp_refinement_moving_local_to_fixed_local_matrix.txt",
            "registration.log",
        }
        if filename not in allowed:
            raise HTTPException(status_code=404, detail="File not found")
        path = _job_directory(job_id) / "result" / filename
        if not path.is_file():
            try:
                restored = await asyncio.to_thread(restore_result, job_id, filename, path)
            except Exception as error:
                raise HTTPException(status_code=502, detail="Stored result is unavailable") from error
            if not restored:
                raise HTTPException(status_code=404, detail="File not found")
        return FileResponse(path, filename=filename)

    return router
