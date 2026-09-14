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

from fastapi import APIRouter, HTTPException

from service.auth import authorize_resource
from service.schemas import CoarseRegistrationRequest
from service.transform_math import business_transforms, transform_matrix


def create_coarse_registration_router(
    session_directory: Callable[[str], Path],
    job_directory: Callable[[str], Path],
    read_status: Callable[[Path], dict[str, Any]],
    write_status: Callable[[Path, dict[str, Any]], None],
    source_available: Callable[[Path, dict[str, Any]], bool],
    restore_sources: Callable[[Path, dict[str, Any]], bool],
    submission_lock: asyncio.Lock,
    worker_path: str,
    persist_task: Callable[[Path, list[str]], None],
    start_task: Callable[[str, list[str]], Any],
    sync_session_job: Callable[[dict[str, Any]], None],
    running_processes: dict[str, asyncio.subprocess.Process],
) -> APIRouter:
    router = APIRouter()

    @router.post("/api/v2/registration-sessions/{session_id}/coarse-register", status_code=202)
    async def create_coarse_registration(session_id: str, request: CoarseRegistrationRequest) -> dict[str, Any]:
        if request.moving_model not in {"a", "b"}:
            raise HTTPException(status_code=400, detail="moving_model must be a or b")
        if not request.overlaps or len(request.overlaps) > 8 or any(not 0.2 <= value <= 1.0 for value in request.overlaps):
            raise HTTPException(status_code=400, detail="overlaps must contain 1 to 8 values between 0.2 and 1.0")
        if not request.random_seeds or len(request.random_seeds) > 8 or any(value <= 0 for value in request.random_seeds):
            raise HTTPException(status_code=400, detail="random_seeds must contain 1 to 8 positive values")
        if len(request.overlaps) * len(request.random_seeds) > 16:
            raise HTTPException(status_code=400, detail="coarse candidate search is limited to 16 combinations")
        if request.delta <= 0 or request.beta <= 0:
            raise HTTPException(status_code=400, detail="delta and beta must be positive")
        if not 4 <= request.sample_limit <= 10000:
            raise HTTPException(status_code=400, detail="sample_limit must be between 4 and 10000")
        if not 1 <= request.base_count <= 10000 or not 1 <= request.base_tries <= 10000:
            raise HTTPException(status_code=400, detail="base counts must be between 1 and 10000")
        if not 1 <= request.max_candidates <= 100000:
            raise HTTPException(status_code=400, detail="max_candidates must be between 1 and 100000")

        async with submission_lock:
            current_session_directory = session_directory(session_id)
            session = read_status(current_session_directory)
            authorize_resource(session)
            if session.get("api_version") != "v2":
                raise HTTPException(status_code=404, detail="V2 registration session not found")
            if not source_available(current_session_directory, session) or not await asyncio.to_thread(
                restore_sources, current_session_directory, session
            ):
                raise HTTPException(status_code=409, detail="Source model files have been cleaned")
            if session.get("status") != "ready":
                raise HTTPException(status_code=409, detail=f"Session status is {session.get('status')}")
            active_job_id = session.get("active_job_id")
            if active_job_id:
                try:
                    if read_status(job_directory(active_job_id)).get("status") in {"queued", "running"}:
                        raise HTTPException(status_code=409, detail="Session already has an active job")
                except HTTPException as error:
                    if error.status_code == 409:
                        raise

            job_id = str(uuid.uuid4())
            current_job_directory = job_directory(job_id)
            input_directory = current_job_directory / "input"
            result_directory = current_job_directory / "result"
            input_directory.mkdir(parents=True)
            result_directory.mkdir()
            command = [
                worker_path, "coarse-register-models",
                "--model-a", str(current_session_directory / "input" / session["model_a_filename"]),
                "--model-b", str(current_session_directory / "input" / session["model_b_filename"]),
                "--moving-model", request.moving_model,
                "--output-dir", str(result_directory),
                "--delta", str(request.delta), "--beta", str(request.beta),
                "--overlaps", ",".join(str(value) for value in request.overlaps), "--base-count", str(request.base_count),
                "--base-tries", str(request.base_tries), "--max-candidates", str(request.max_candidates),
                "--sample-limit", str(request.sample_limit),
                "--random-seeds", ",".join(str(value) for value in request.random_seeds),
            ]
            transforms = business_transforms(session)
            for model in ("a", "b"):
                path = input_directory / f"model_{model}_to_business.txt"
                path.write_text("\n".join(" ".join(f"{value:.17g}" for value in row)
                                           for row in transform_matrix(transforms[model])) + "\n", encoding="utf-8")
                command.extend([f"--model-{model}-to-business", str(path)])
            persist_task(current_job_directory, command)
            created_at = time.time()
            status = {
                "job_id": job_id, "job_type": "coarse_registration", "status": "queued",
                "created_at_unix": created_at, "manual_session_id": session_id,
                "owner_id": session.get("owner_id"), "moving_model": request.moving_model,
            }
            write_status(current_job_directory, status)
            session.setdefault("coarse_registrations", []).append({
                "job_id": job_id, "status": "queued", "created_at_unix": created_at,
                "moving_model": request.moving_model,
                "status_url": f"/api/v2/coarse-registrations/{job_id}",
                "result_url": f"/api/v2/coarse-registrations/{job_id}/result",
            })
            session["active_job_id"] = job_id
            write_status(current_session_directory, session)
        start_task(job_id, command)
        return {"job_id": job_id, "status": "queued",
                "status_url": f"/api/v2/coarse-registrations/{job_id}",
                "result_url": f"/api/v2/coarse-registrations/{job_id}/result"}

    def coarse_status(job_id: str) -> tuple[Path, dict[str, Any]]:
        directory = job_directory(job_id)
        status = read_status(directory)
        authorize_resource(status)
        if status.get("job_type") != "coarse_registration":
            raise HTTPException(status_code=404, detail="Coarse registration job not found")
        return directory, status

    @router.get("/api/v2/coarse-registrations/{job_id}")
    async def get_coarse_registration(job_id: str) -> dict[str, Any]:
        return coarse_status(job_id)[1]

    @router.post("/api/v2/coarse-registrations/{job_id}/cancel")
    async def cancel_coarse_registration(job_id: str) -> dict[str, Any]:
        directory, status = coarse_status(job_id)
        if status.get("status") == "cancelled":
            return status
        if status.get("status") not in {"queued", "running"}:
            raise HTTPException(status_code=409, detail=f"Job status is {status.get('status')}")
        status.update(status="cancelled", error_code="task_cancelled",
                      error="Coarse registration cancelled by user", finished_at_unix=time.time())
        write_status(directory, status)
        sync_session_job(status)
        process = running_processes.get(job_id)
        if process is not None and process.returncode is None:
            process.kill()
        if process is None:
            shutil.rmtree(directory / "input", ignore_errors=True)
        return status

    @router.get("/api/v2/coarse-registrations/{job_id}/result")
    async def get_coarse_registration_result(job_id: str) -> dict[str, Any]:
        directory, status = coarse_status(job_id)
        if status.get("status") != "succeeded":
            raise HTTPException(status_code=409, detail=f"Job status is {status.get('status')}")
        path = directory / "result" / "coarse-registration.json"
        if not path.is_file():
            raise HTTPException(status_code=404, detail="Coarse registration result not found")
        return json.loads(path.read_text(encoding="utf-8"))

    return router
