# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import HTTPException


def job_directory(runtime_root: Path, job_id: str) -> Path:
    try:
        parsed = uuid.UUID(job_id)
    except ValueError as error:
        raise HTTPException(status_code=404, detail="Job not found") from error
    return runtime_root / "jobs" / str(parsed)


def session_directory(runtime_root: Path, session_id: str) -> Path:
    try:
        parsed = uuid.UUID(session_id)
    except ValueError as error:
        raise HTTPException(status_code=404, detail="Manual registration session not found") from error
    return runtime_root / "manual-sessions" / str(parsed)


def workspace_id(value: str) -> str:
    try:
        return str(uuid.UUID(value))
    except ValueError as error:
        raise HTTPException(status_code=400, detail="workspace_id must be a UUID") from error


def history_directory(runtime_root: Path, value: str) -> Path:
    return runtime_root / "history" / workspace_id(value)


def history_path(runtime_root: Path, workspace: str, session_id: str) -> Path:
    return history_directory(runtime_root, workspace) / f"{uuid.UUID(session_id)}.json"


def status_path(directory: Path) -> Path:
    return directory / "status.json"


def write_status(directory: Path, status: dict[str, Any]) -> None:
    status["updated_at_unix"] = time.time()
    temporary = directory / "status.json.tmp"
    temporary.write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(status_path(directory))


def read_status(directory: Path) -> dict[str, Any]:
    path = status_path(directory)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Job not found")
    return json.loads(path.read_text(encoding="utf-8"))
