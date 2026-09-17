# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import asyncio
import shutil
import secrets
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from service.schemas import TransformParameters
from service.auth import current_principal
from service.dataset_formats import DatasetFormatError, probe_dataset as _probe_dataset
from service.storage import workspace_id as _workspace_id
from service.uploads import save_upload_with_sha256 as _save_upload_with_sha256
from service.uploads import save_upload_directory_with_sha256 as _save_upload_directory_with_sha256
from service.validation import model_extension as _model_extension, validate_transform as _validate_transform


def create_upload_router(
    _manual_session_directory: Callable[[str], Path],
    _write_status: Callable[[Path, dict[str, Any]], None],
    worker_path: str,
    source_retention_hours: int,
    archive_sources: Callable[[Path, dict[str, Any]], None],
    start_preview: Callable[[str, list[str]], Any],
) -> APIRouter:
    router = APIRouter()

    @router.post("/api/v2/registration-sessions", status_code=202)
    async def create_model_registration_session(
        model_a: Annotated[UploadFile | None, File(description="Model A single file")] = None,
        model_b: Annotated[UploadFile | None, File(description="Model B single file")] = None,
        model_a_files: Annotated[list[UploadFile] | None, File(description="Model A dataset directory files")] = None,
        model_b_files: Annotated[list[UploadFile] | None, File(description="Model B dataset directory files")] = None,
        output_direction: Annotated[str, Form()] = "a_to_b",
        moving_model: Annotated[str, Form()] = "auto",
        model_a_stream_cache: Annotated[bool, Form()] = False,
        model_b_stream_cache: Annotated[bool, Form()] = False,
        workspace_id: Annotated[str, Form()] = "",
        model_a_transform: Annotated[str, Form()] = "",
        model_b_transform: Annotated[str, Form()] = "",
    ) -> dict[str, Any]:
        selections = ((model_a, model_a_files, "a"), (model_b, model_b_files, "b"))
        if any((single is None) == (not files) for single, files, _ in selections):
            raise HTTPException(status_code=400, detail="Each model must provide exactly one single file or one dataset directory")
        extension_a = _model_extension(model_a) if model_a else ".zip"
        extension_b = _model_extension(model_b) if model_b else ".zip"
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
                _save_upload_with_sha256(model_a, path_a) if model_a else _save_upload_directory_with_sha256(model_a_files or [], path_a),
                _save_upload_with_sha256(model_b, path_b) if model_b else _save_upload_directory_with_sha256(model_b_files or [], path_b),
            )
            if bytes_a == 0 or bytes_b == 0:
                raise HTTPException(status_code=400, detail="Uploaded files must not be empty")
            try:
                dataset_a = _probe_dataset(path_a)
                dataset_b = _probe_dataset(path_b)
            except DatasetFormatError as error:
                raise HTTPException(status_code=400, detail=str(error)) from error
            cache_formats = {"gaussian_ply", "compressed_ply", "spz", "sog", "streamed_sog", "lcc", "lcc2"}
            for requested, dataset in ((model_a_stream_cache, dataset_a), (model_b_stream_cache, dataset_b)):
                if requested and dataset.format not in cache_formats:
                    raise HTTPException(status_code=400, detail="Streamed cache is only available for Gaussian models")
        except Exception:
            shutil.rmtree(session_directory, ignore_errors=True)
            raise
        status: dict[str, Any] = {
            "session_id": session_id,
            "api_version": "v2",
            "workspace_id": workspace_id,
            "owner_id": current_principal().key_id,
            "preview_access_token": secrets.token_urlsafe(32),
            "status": "queued",
            "created_at_unix": time.time(),
            "source_expires_at_unix": time.time() + source_retention_hours * 3600,
            "model_a_filename": path_a.name,
            "model_b_filename": path_b.name,
            "output_direction": output_direction,
            "moving_model": moving_model,
            "business_transforms": {"a": transform_a.model_dump(), "b": transform_b.model_dump()},
            "inputs": {
                "model_a_bytes": bytes_a, "model_b_bytes": bytes_b,
                "model_a_format": dataset_a.format, "model_b_format": dataset_b.format,
                "model_a_upload_extension": extension_a[1:], "model_b_upload_extension": extension_b[1:],
                "model_a_original_filename": Path(model_a.filename or path_a.name).name if model_a else Path((model_a_files or [])[0].filename or "dataset").parts[0],
                "model_b_original_filename": Path(model_b.filename or path_b.name).name if model_b else Path((model_b_files or [])[0].filename or "dataset").parts[0],
                "model_a_upload_shape": "file" if model_a else "directory",
                "model_b_upload_shape": "file" if model_b else "directory",
                "model_a_sha256": sha256_a, "model_b_sha256": sha256_b,
                "model_a_dataset": {
                    **dataset_a.to_dict(), "xyz_status": "pending",
                    "xyz_stage": "queued", "xyz_progress": 10,
                    "gaussian_status": "pending" if dataset_a.gaussian_capable else "not_available",
                    "gaussian_stage": "waiting" if dataset_a.gaussian_capable else "not_available",
                    "gaussian_cache_requested": model_a_stream_cache and dataset_a.format != "streamed_sog",
                },
                "model_b_dataset": {
                    **dataset_b.to_dict(), "xyz_status": "pending",
                    "xyz_stage": "queued", "xyz_progress": 10,
                    "gaussian_status": "pending" if dataset_b.gaussian_capable else "not_available",
                    "gaussian_stage": "waiting" if dataset_b.gaussian_capable else "not_available",
                    "gaussian_cache_requested": model_b_stream_cache and dataset_b.format != "streamed_sog",
                },
            },
            "editor_url": f"/?session={session_id}&api=v2",
        }
        try:
            await asyncio.to_thread(archive_sources, session_directory, status)
        except Exception as error:
            shutil.rmtree(session_directory, ignore_errors=True)
            raise HTTPException(status_code=502, detail="Object storage upload failed") from error
        _write_status(session_directory, status)
        command = [
            worker_path, "prepare-model-preview",
            "--model-a", str(path_a), "--model-b", str(path_b),
            "--output-dir", str(preview_directory),
            "--model-a-limit", "300000", "--model-b-limit", "300000",
        ]
        start_preview(session_id, command)
        return {
            "session_id": session_id, "workspace_id": workspace_id, "status": "queued",
            "status_url": f"/api/v2/registration-sessions/{session_id}",
            "editor_url": status["editor_url"],
        }

    return router
