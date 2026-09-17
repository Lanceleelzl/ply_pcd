# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import json
import re
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from service.auth import authorize_resource, current_principal, resource_owned_by
from service.streaming_zip import directory_zip_metadata, stream_directory_zip


HistoryDirectory = Callable[[str], Path]
HistoryPath = Callable[[str, str], Path]
HistoryView = Callable[[dict[str, Any]], dict[str, Any]]
SessionTaskRecord = Callable[[dict[str, Any]], dict[str, Any]]
WorkspaceId = Callable[[str], str]


def _stream_cache_filename(status: dict[str, Any], model: str) -> str:
    original = status.get("inputs", {}).get(f"model_{model}_original_filename")
    fallback = status.get(f"model_{model}_filename") or f"model-{model}"
    stem = Path(str(original or fallback)).stem.strip() or f"model-{model}"
    safe_stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", stem).rstrip(" .")[:160] or f"model-{model}"
    timestamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
    return f"{safe_stem}-streamed-sog-{timestamp}.zip"


def create_history_router(
    history_directory: HistoryDirectory,
    history_path: HistoryPath,
    history_view: HistoryView,
    parse_workspace_id: WorkspaceId,
    session_directory: Callable[[str], Path],
    sessions_directory: Callable[[], Path],
    read_status: Callable[[Path], dict[str, Any]],
    session_task_record: SessionTaskRecord,
) -> APIRouter:
    router = APIRouter(prefix="/api/v2/registration-history")

    @router.get("")
    async def get_registration_history(workspace_id: str) -> dict[str, Any]:
        parsed_workspace_id = parse_workspace_id(workspace_id)
        directory = history_directory(parsed_workspace_id)
        records_by_session: dict[str, dict[str, Any]] = {}
        if directory.is_dir():
            for path in directory.glob("*.json"):
                try:
                    record = json.loads(path.read_text(encoding="utf-8"))
                    if resource_owned_by(current_principal(), record.get("owner_id")):
                        records_by_session[record["session_id"]] = record
                except (OSError, ValueError, json.JSONDecodeError, HTTPException):
                    continue
        root = sessions_directory()
        if root.is_dir():
            for path in root.iterdir():
                if not path.is_dir():
                    continue
                try:
                    status = read_status(path)
                    if (
                        status.get("api_version") == "v2"
                        and status.get("workspace_id") == parsed_workspace_id
                        and resource_owned_by(current_principal(), status.get("owner_id"))
                    ):
                        record = records_by_session.setdefault(status["session_id"], session_task_record(status))
                        record["updated_at_unix"] = status.get("updated_at_unix")
                except (OSError, ValueError, json.JSONDecodeError, HTTPException, KeyError):
                    continue
        records = [history_view(record) for record in records_by_session.values()]
        records = [item for item in records if item.get("has_registration_result") or item.get("source_available")]
        records.sort(key=lambda item: float(item.get("updated_at_unix") or item.get("completed_at_unix") or item.get("created_at_unix") or 0), reverse=True)
        return {"workspace_id": parsed_workspace_id, "items": records}

    @router.get("/{session_id}")
    async def get_registration_history_item(session_id: str, workspace_id: str) -> dict[str, Any]:
        path = history_path(workspace_id, session_id)
        if path.is_file():
            record = json.loads(path.read_text(encoding="utf-8"))
            authorize_resource(record)
        else:
            status = read_status(session_directory(session_id))
            authorize_resource(status)
            if status.get("api_version") != "v2" or status.get("workspace_id") != parse_workspace_id(workspace_id):
                raise HTTPException(status_code=404, detail="Registration task not found")
            record = session_task_record(status)
        return history_view(record)

    @router.get("/{session_id}/stream-cache/{model}")
    async def download_stream_cache(session_id: str, model: str, workspace_id: str) -> StreamingResponse:
        if model not in {"a", "b"}:
            raise HTTPException(status_code=404, detail="Model cache not found")
        directory = session_directory(session_id)
        status = read_status(directory)
        authorize_resource(status)
        if status.get("workspace_id") != parse_workspace_id(workspace_id):
            raise HTTPException(status_code=404, detail="Registration task not found")
        dataset = status.get("inputs", {}).get(f"model_{model}_dataset", {})
        relative = dataset.get("gaussian_cache_path")
        if dataset.get("gaussian_cache_status") != "ready" or not isinstance(relative, str):
            raise HTTPException(status_code=404, detail="Streamed cache is not available")
        entrypoint = (directory / relative).resolve()
        try:
            entrypoint.relative_to(directory.resolve())
        except ValueError as error:
            raise HTTPException(status_code=404, detail="Streamed cache path is invalid") from error
        cache_directory = entrypoint.parent
        if not entrypoint.is_file() or not cache_directory.is_dir():
            raise HTTPException(status_code=404, detail="Streamed cache files have been released")
        filename = _stream_cache_filename(status, model)
        file_count, source_bytes = directory_zip_metadata(cache_directory)
        headers = {
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
            "X-Cache-File-Count": str(file_count),
            "X-Cache-Source-Bytes": str(source_bytes),
        }
        return StreamingResponse(stream_directory_zip(cache_directory), media_type="application/zip", headers=headers)

    return router
