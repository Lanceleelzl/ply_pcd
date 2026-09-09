# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException


HistoryDirectory = Callable[[str], Path]
HistoryPath = Callable[[str, str], Path]
HistoryView = Callable[[dict[str, Any]], dict[str, Any]]
WorkspaceId = Callable[[str], str]


def create_history_router(
    history_directory: HistoryDirectory,
    history_path: HistoryPath,
    history_view: HistoryView,
    parse_workspace_id: WorkspaceId,
) -> APIRouter:
    router = APIRouter(prefix="/api/v2/registration-history")

    @router.get("")
    async def get_registration_history(workspace_id: str) -> dict[str, Any]:
        directory = history_directory(workspace_id)
        records: list[dict[str, Any]] = []
        if directory.is_dir():
            for path in directory.glob("*.json"):
                try:
                    record = json.loads(path.read_text(encoding="utf-8"))
                    records.append(history_view(record))
                except (OSError, ValueError, json.JSONDecodeError, HTTPException):
                    continue
        records.sort(key=lambda item: float(item.get("completed_at_unix") or 0), reverse=True)
        return {"workspace_id": parse_workspace_id(workspace_id), "items": records}

    @router.get("/{session_id}")
    async def get_registration_history_item(session_id: str, workspace_id: str) -> dict[str, Any]:
        path = history_path(workspace_id, session_id)
        if not path.is_file():
            raise HTTPException(status_code=404, detail="Registration history not found")
        return history_view(json.loads(path.read_text(encoding="utf-8")))

    return router
