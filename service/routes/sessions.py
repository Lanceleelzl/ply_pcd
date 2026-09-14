# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from service.schemas import BusinessTransformsRequest, TransformParameters, WorkspaceRequest
from service.auth import authorize_resource


DirectoryResolver = Callable[[str], Path]
HistoryWriter = Callable[[Path, dict[str, Any]], dict[str, Any] | None]
SourceAvailability = Callable[[Path, dict[str, Any]], bool]
SourceRelease = Callable[[Path, dict[str, Any]], None]
StatusReader = Callable[[Path], dict[str, Any]]
StatusWriter = Callable[[Path, dict[str, Any]], None]
TransformValidator = Callable[[TransformParameters], None]
WorkspaceId = Callable[[str], str]


def create_session_router(
    session_directory: DirectoryResolver,
    job_directory: DirectoryResolver,
    read_status: StatusReader,
    write_status: StatusWriter,
    source_available: SourceAvailability,
    parse_workspace_id: WorkspaceId,
    validate_transform: TransformValidator,
    write_history: HistoryWriter,
    release_source_data: SourceRelease,
    source_retention_hours: int,
    worker_path: str,
    restore_sources: Callable[[Path, dict[str, Any]], bool],
    start_preview: Callable[[str, list[str]], Any],
) -> APIRouter:
    router = APIRouter(prefix="/api/v2/registration-sessions")

    @router.put("/{session_id}/business-transforms")
    async def update_business_transforms(
        session_id: str,
        request: BusinessTransformsRequest,
    ) -> dict[str, Any]:
        validate_transform(request.model_a)
        validate_transform(request.model_b)
        directory = session_directory(session_id)
        status = read_status(directory)
        authorize_resource(status)
        if status.get("api_version") != "v2":
            raise HTTPException(status_code=404, detail="V2 registration session not found")
        active_job_id = status.get("active_job_id")
        if active_job_id:
            try:
                if read_status(job_directory(active_job_id)).get("status") in {"queued", "running"}:
                    raise HTTPException(status_code=409, detail="Cannot change transforms during registration")
            except HTTPException as error:
                if error.status_code == 409:
                    raise
        status["business_transforms"] = {
            "a": request.model_a.model_dump(),
            "b": request.model_b.model_dump(),
        }
        status["active_job_id"] = None
        write_status(directory, status)
        return {"business_transforms": status["business_transforms"]}

    @router.get("/{session_id}")
    async def get_model_registration_session(session_id: str) -> dict[str, Any]:
        directory = session_directory(session_id)
        status = read_status(directory)
        authorize_resource(status)
        if status.get("api_version") != "v2":
            raise HTTPException(status_code=404, detail="V2 registration session not found")
        status["source_available"] = source_available(directory, status)
        status["restartable"] = status["source_available"]
        return status

    def read_owned_session(session_id: str, workspace_id: str) -> tuple[Path, dict[str, Any]]:
        directory = session_directory(session_id)
        status = read_status(directory)
        authorize_resource(status)
        if status.get("api_version") != "v2" or status.get("workspace_id") != parse_workspace_id(workspace_id):
            raise HTTPException(status_code=404, detail="V2 registration session not found")
        return directory, status

    @router.post("/{session_id}/retain")
    async def retain_model_registration_session(
        session_id: str,
        request: WorkspaceRequest,
    ) -> dict[str, Any]:
        directory, status = read_owned_session(session_id, request.workspace_id)
        if not source_available(directory, status):
            raise HTTPException(status_code=409, detail="Source model files have been cleaned")
        status["source_expires_at_unix"] = time.time() + source_retention_hours * 3600
        write_status(directory, status)
        record = write_history(directory, status)
        return {
            "session_id": session_id,
            "source_expires_at_unix": status["source_expires_at_unix"],
            "history": record,
        }

    @router.post("/{session_id}/release")
    async def release_model_registration_session(
        session_id: str,
        request: WorkspaceRequest,
    ) -> dict[str, Any]:
        directory, status = read_owned_session(session_id, request.workspace_id)
        await asyncio.to_thread(release_source_data, directory, status)
        return {"session_id": session_id, "source_available": False, "restartable": False}

    @router.post("/{session_id}/resume", status_code=202)
    async def resume_model_registration_session(session_id: str, request: WorkspaceRequest) -> dict[str, Any]:
        directory = session_directory(session_id)
        status = read_status(directory)
        authorize_resource(status)
        if status.get("api_version") != "v2" or status.get("workspace_id") != parse_workspace_id(request.workspace_id):
            raise HTTPException(status_code=404, detail="V2 registration session not found")
        if not source_available(directory, status) or not await asyncio.to_thread(restore_sources, directory, status):
            raise HTTPException(status_code=409, detail="Source model files have been cleaned")
        preview_directory = directory / "preview"
        preview_ready = all((preview_directory / name).is_file() for name in ("model-a-points.bin", "model-b-points.bin"))
        if preview_ready and status.get("status") == "ready":
            return {"session_id": session_id, "status": "ready", "editor_url": status["editor_url"]}
        if status.get("status") in {"queued", "preparing"}:
            return {"session_id": session_id, "status": status["status"], "editor_url": status["editor_url"]}
        preview_directory.mkdir(parents=True, exist_ok=True)
        status["status"] = "queued"
        status.pop("error", None)
        status.pop("error_code", None)
        write_status(directory, status)
        command = [
            worker_path, "prepare-model-preview",
            "--model-a", str(directory / "input" / status["model_a_filename"]),
            "--model-b", str(directory / "input" / status["model_b_filename"]),
            "--output-dir", str(preview_directory),
            "--model-a-limit", "300000", "--model-b-limit", "300000",
        ]
        start_preview(session_id, command)
        return {"session_id": session_id, "status": "queued", "editor_url": status["editor_url"]}


    @router.get("/{session_id}/preview/{model}")
    async def get_model_registration_preview(session_id: str, model: str) -> FileResponse:
        directory = session_directory(session_id)
        status = read_status(directory)
        authorize_resource(status)
        if status.get("api_version") != "v2":
            raise HTTPException(status_code=404, detail="V2 registration session not found")
        if model == "model-a":
            path = directory / "preview" / "model-a-points.bin"
            filename = "model-a-points.bin"
        elif model == "model-b":
            path = directory / "preview" / "model-b-points.bin"
            filename = "model-b-points.bin"
        elif model == "gaussian-a" and status.get("metadata", {}).get("gaussian_a_available"):
            path = directory / "input" / status["model_a_filename"]
            filename = status["model_a_filename"]
        elif model == "gaussian-b" and status.get("metadata", {}).get("gaussian_b_available"):
            path = directory / "input" / status["model_b_filename"]
            filename = status["model_b_filename"]
        else:
            raise HTTPException(status_code=404, detail="Preview not found")
        if not path.is_file():
            raise HTTPException(status_code=404, detail="Preview not found")
        return FileResponse(path, media_type="application/octet-stream", filename=filename)

    return router
