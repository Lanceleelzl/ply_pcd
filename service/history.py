# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import json
import shutil
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import HTTPException


def write_history(session_directory: Path, session_status: dict[str, Any], *, _job_directory: Callable[[str], Path], _history_path: Callable[[str, str], Path], _history_directory: Callable[[str], Path], SERVICE_VERSION: str) -> dict[str, Any] | None:
    workspace_id = session_status.get("workspace_id")
    if session_status.get("api_version") != "v2" or not workspace_id:
        return None
    completed = [entry for entry in session_status.get("registrations", []) if entry.get("status") == "succeeded"]
    if not completed:
        return None
    latest = max(completed, key=lambda entry: float(entry.get("finished_at_unix", 0)))
    job_id = latest.get("job_id")
    if not job_id:
        return None
    result_path = _job_directory(job_id) / "result" / "registration.json"
    if not result_path.is_file():
        existing = _history_path(workspace_id, session_status["session_id"])
        return json.loads(existing.read_text(encoding="utf-8")) if existing.is_file() else None
    result = json.loads(result_path.read_text(encoding="utf-8"))
    metadata = session_status.get("metadata", {}).get("models", {})
    inputs = session_status.get("inputs", {})
    record = {
        "session_id": session_status["session_id"],
        "workspace_id": workspace_id,
        "owner_id": session_status.get("owner_id"),
        "status": "succeeded",
        "created_at_unix": session_status.get("created_at_unix"),
        "completed_at_unix": latest.get("finished_at_unix"),
        "source_expires_at_unix": session_status.get("source_expires_at_unix"),
        "service_version": SERVICE_VERSION,
        "output_direction": latest.get("output_direction", session_status.get("output_direction")),
        "moving_model": latest.get("moving_model", session_status.get("moving_model")),
        "models": {
            "a": {
                "filename": inputs.get("model_a_original_filename", session_status.get("model_a_filename")),
                "format": inputs.get("model_a_format"), "bytes": inputs.get("model_a_bytes"),
                "sha256": inputs.get("model_a_sha256"), "point_count": metadata.get("a", {}).get("source_point_count"),
            },
            "b": {
                "filename": inputs.get("model_b_original_filename", session_status.get("model_b_filename")),
                "format": inputs.get("model_b_format"), "bytes": inputs.get("model_b_bytes"),
                "sha256": inputs.get("model_b_sha256"), "point_count": metadata.get("b", {}).get("source_point_count"),
            },
        },
        "parameters": latest.get("parameters", result.get("parameters", {})),
        "initial_source": latest.get("initial_source", result.get("initial_source", "manual")),
        "recommended_matrix": result.get("recommended_matrix"),
        "a_to_b": result.get("a_to_b"), "b_to_a": result.get("b_to_a"),
        "file_a_to_b": result.get("file_a_to_b"), "file_b_to_a": result.get("file_b_to_a"),
        "business_transforms": result.get("business_transforms", session_status.get("business_transforms")),
        "metrics": result.get("metrics", {}),
    }
    directory = _history_directory(workspace_id)
    directory.mkdir(parents=True, exist_ok=True)
    path = _history_path(workspace_id, session_status["session_id"])
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)
    return record


def release_source_data(session_directory: Path, session_status: dict[str, Any], *, _job_directory: Callable[[str], Path], _read_status: Callable[[Path], dict[str, Any]], _write_status: Callable[[Path, dict[str, Any]], None], _write_v2_history: Callable[[Path, dict[str, Any]], dict[str, Any] | None]) -> None:
    active_job_id = session_status.get("active_job_id")
    if active_job_id:
        try:
            if _read_status(_job_directory(active_job_id)).get("status") in {"queued", "running"}:
                raise HTTPException(status_code=409, detail="Active job must finish or be cancelled first")
        except HTTPException as error:
            if error.status_code == 409:
                raise
    _write_v2_history(session_directory, session_status)
    for directory_name in ("input", "preview", "datasets", "computed"):
        shutil.rmtree(session_directory / directory_name, ignore_errors=True)
    for filename in ("worker.stdout.log", "worker.stderr.log"):
        (session_directory / filename).unlink(missing_ok=True)
    for entry in [*session_status.get("registrations", []), *session_status.get("coarse_registrations", [])]:
        job_id = entry.get("job_id")
        if not job_id:
            continue
        job_directory = _job_directory(job_id)
        try:
            job_status = _read_status(job_directory)
        except HTTPException:
            continue
        if job_status.get("status") in {"succeeded", "failed", "cancelled"}:
            shutil.rmtree(job_directory)
    session_status["source_released_at_unix"] = time.time()
    session_status["source_available"] = False
    _write_status(session_directory, session_status)


def history_view(record: dict[str, Any], *, _manual_session_directory: Callable[[str], Path], _read_status: Callable[[Path], dict[str, Any]], _v2_source_available: Callable[[Path, dict[str, Any]], bool]) -> dict[str, Any]:
    session_directory = _manual_session_directory(record["session_id"])
    try:
        status = _read_status(session_directory)
        source_available = _v2_source_available(session_directory, status)
        source_expires = status.get("source_expires_at_unix")
    except (HTTPException, OSError, json.JSONDecodeError):
        source_available = False
        source_expires = record.get("source_expires_at_unix")
    return {
        **record,
        "source_available": source_available,
        "restartable": source_available,
        "source_expires_at_unix": source_expires,
    }


