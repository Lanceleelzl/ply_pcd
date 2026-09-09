# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, Response


StatusReader = Callable[[Path], dict[str, Any]]
SessionDirectory = Callable[[str], Path]


def create_web_router(
    static_root: Path,
    session_directory: SessionDirectory,
    read_status: StatusReader,
) -> APIRouter:
    router = APIRouter()

    def web_index() -> Response:
        built_index = static_root / "index.html"
        if built_index.is_file():
            return FileResponse(built_index)
        return HTMLResponse((static_root.parent / "index.html").read_text(encoding="utf-8"))

    @router.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @router.get("/")
    async def index() -> Response:
        return web_index()

    @router.get("/manual-registration/{session_id}")
    async def manual_registration_page(session_id: str) -> Response:
        session_directory(session_id)
        return web_index()

    @router.get("/registration/{session_id}")
    async def model_registration_page(session_id: str) -> Response:
        status = read_status(session_directory(session_id))
        if status.get("api_version") != "v2":
            raise HTTPException(status_code=404, detail="V2 registration session not found")
        return web_index()

    return router
