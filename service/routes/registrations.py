# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from service.schemas import ModelRegistrationRequest
from service.auth import authorize_resource
from service.transform_math import business_transforms as _business_transforms, transform_matrix as _transform_matrix
from service.validation import (
    validate_initial_matrix as _validate_initial_matrix,
    validate_registration_parameters as _validate_registration_parameters,
)


def create_registration_router(
    _manual_session_directory: Callable[[str], Path],
    _job_directory: Callable[[str], Path],
    _read_status: Callable[[Path], dict[str, Any]],
    _write_status: Callable[[Path, dict[str, Any]], None],
    _v2_source_available: Callable[[Path, dict[str, Any]], bool],
    _manual_submission_lock: asyncio.Lock,
    worker_path: str,
    restore_sources: Callable[[Path, dict[str, Any]], bool],
    persist_registration: Callable[[Path, list[str]], None],
    start_registration: Callable[[str, list[str]], Any],
) -> APIRouter:
    router = APIRouter()

    @router.post("/api/v2/registration-sessions/{session_id}/register", status_code=202)
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
        if request.initial_source not in {"manual", "4pcs", "4pcs_adjusted"}:
            raise HTTPException(status_code=400, detail="initial_source is invalid")
        async with _manual_submission_lock:
            session_directory = _manual_session_directory(session_id)
            session_status = _read_status(session_directory)
            authorize_resource(session_status)
            if session_status.get("api_version") != "v2":
                raise HTTPException(status_code=404, detail="V2 registration session not found")
            if not _v2_source_available(session_directory, session_status) or not await asyncio.to_thread(
                restore_sources, session_directory, session_status
            ):
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
            command = [
                worker_path, "register-models",
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
            persist_registration(job_directory, command)
            status = {
                "job_id": job_id, "status": "queued", "created_at_unix": time.time(),
                "manual_session_id": session_id, "inputs": session_status["inputs"],
                "owner_id": session_status.get("owner_id"),
                "coordinate_space": request.coordinate_space,
                "initial_source": request.initial_source,
            }
            _write_status(job_directory, status)
            session_status.setdefault("registrations", []).append({
                "job_id": job_id, "status": "queued", "created_at_unix": status["created_at_unix"],
                "initial_moving_local_to_fixed_local": request.initial_moving_local_to_fixed_local,
                "output_direction": request.output_direction, "moving_model": request.moving_model,
                "coordinate_space": request.coordinate_space,
                "initial_source": request.initial_source,
                "parameters": {
                    "min_rms_decrease": request.min_rms_decrease,
                    "sampling_limit": request.sampling_limit,
                    "overlap": request.overlap,
                    "random_seed": request.random_seed,
                },
                "status_url": f"/api/v2/registrations/{job_id}",
                "progress_url": f"/api/v2/registrations/{job_id}/events",
            })
            session_status["active_job_id"] = job_id
            session_status["output_direction"] = request.output_direction
            session_status["moving_model"] = request.moving_model
            _write_status(session_directory, session_status)
        start_registration(job_id, command)
        return {
            "job_id": job_id,
            "status": "queued",
            "status_url": f"/api/v2/registrations/{job_id}",
            "progress_url": f"/api/v2/registrations/{job_id}/events",
        }

    return router
