# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import hmac
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse


def create_gaussian_resource_router(
    session_directory: Callable[[str], Path],
    read_status: Callable[[Path], dict[str, Any]],
) -> APIRouter:
    router = APIRouter(prefix="/gaussian-resources")

    @router.get("/{session_id}/{token}/{model}/{resource_path:path}")
    async def get_resource(session_id: str, token: str, model: str, resource_path: str) -> FileResponse:
        if model not in {"a", "b"}:
            raise HTTPException(status_code=404, detail="Gaussian resource not found")
        directory = session_directory(session_id)
        status = read_status(directory)
        expected = status.get("preview_access_token", "")
        if not expected or not hmac.compare_digest(token, expected):
            raise HTTPException(status_code=404, detail="Gaussian resource not found")
        relative = Path(resource_path.replace("\\", "/"))
        root = directory.resolve()
        path = (directory / relative).resolve()
        dataset = status.get("inputs", {}).get(f"model_{model}_dataset", {})
        gaussian_path = dataset.get("gaussian_path")
        gaussian_file = (directory / gaussian_path).resolve() if gaussian_path else None
        allowed = bool(
            gaussian_file
            and root in path.parents
            and (
                path == gaussian_file
                or (dataset.get("format") in {"sog", "streamed_sog"} or dataset.get("gaussian_resource_tree"))
                and gaussian_file.parent in path.parents
            )
            and path.is_file()
        )
        if not allowed:
            raise HTTPException(status_code=404, detail="Gaussian resource not found")
        media_types = {".json": "application/json", ".webp": "image/webp", ".ply": "application/octet-stream", ".sog": "application/octet-stream"}
        return FileResponse(path, media_type=media_types.get(path.suffix.lower(), "application/octet-stream"))

    return router
