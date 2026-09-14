# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any


def normalize_task_links(status: dict[str, Any]) -> dict[str, Any]:
    # Normalize persisted task links without rewriting historical files.
    for record in [status, *status.get("registrations", [])]:
        for field in ("status_url", "progress_url", "result_url"):
            value = record.get(field)
            if isinstance(value, str) and value.startswith("/api/v1/registrations/"):
                record[field] = value.replace("/api/v1/registrations/", "/api/v2/registrations/", 1)
    return status


def source_available(session_directory: Path, status: dict[str, Any]) -> bool:
    return all(
        (session_directory / "input" / status.get(field, "")).is_file()
        for field in ("model_a_filename", "model_b_filename")
    )


def sync_session_job(
    job_status: dict[str, Any],
    *,
    resolve_session_directory: Callable[[str], Path],
    read_status: Callable[[Path], dict[str, Any]],
    write_status: Callable[[Path, dict[str, Any]], None],
    write_history: Callable[[Path, dict[str, Any]], dict[str, Any] | None],
) -> None:
    session_id = job_status.get("manual_session_id")
    if not session_id:
        return
    session_directory = resolve_session_directory(session_id)
    session_status = read_status(session_directory)
    registrations = session_status.setdefault("registrations", [])
    entry = next((item for item in registrations if item.get("job_id") == job_status["job_id"]), None)
    if entry is None:
        return
    for field in (
        "status", "started_at_unix", "finished_at_unix", "result_url", "error_code", "error"
    ):
        if field in job_status:
            entry[field] = job_status[field]
    if job_status.get("status") in {"succeeded", "failed", "cancelled"}:
        if session_status.get("active_job_id") == job_status["job_id"]:
            session_status["active_job_id"] = None
    else:
        session_status["active_job_id"] = job_status["job_id"]
    write_status(session_directory, session_status)
    if job_status.get("status") == "succeeded" and session_status.get("api_version") == "v2":
        try:
            write_history(session_directory, session_status)
        except (OSError, ValueError, json.JSONDecodeError):
            pass


def sync_coarse_session_job(
    job_status: dict[str, Any],
    *,
    resolve_session_directory: Callable[[str], Path],
    read_status: Callable[[Path], dict[str, Any]],
    write_status: Callable[[Path, dict[str, Any]], None],
) -> None:
    session_id = job_status.get("manual_session_id")
    if not session_id:
        return
    directory = resolve_session_directory(session_id)
    session = read_status(directory)
    entry = next((item for item in session.setdefault("coarse_registrations", [])
                  if item.get("job_id") == job_status.get("job_id")), None)
    if entry is None:
        return
    for field in ("status", "started_at_unix", "finished_at_unix", "result_url", "error_code", "error"):
        if field in job_status:
            entry[field] = job_status[field]
    if job_status.get("status") in {"succeeded", "failed", "cancelled"}:
        if session.get("active_job_id") == job_status.get("job_id"):
            session["active_job_id"] = None
    else:
        session["active_job_id"] = job_status.get("job_id")
    write_status(directory, session)
