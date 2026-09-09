# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

from service.schemas import BusinessTransformsRequest, TransformParameters, WorkspaceRequest


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
        if status.get("api_version") != "v2":
            raise HTTPException(status_code=404, detail="V2 registration session not found")
        status["source_available"] = source_available(directory, status)
        status["restartable"] = status["source_available"]
        return status

    def read_owned_session(session_id: str, workspace_id: str) -> tuple[Path, dict[str, Any]]:
        directory = session_directory(session_id)
        status = read_status(directory)
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
        release_source_data(directory, status)
        return {"session_id": session_id, "source_available": False, "restartable": False}

    return router
