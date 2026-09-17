# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

from service.dataset_formats import DatasetFormatError, validate_streamed_sog_directory


def normalize_task_links(status: dict[str, Any]) -> dict[str, Any]:
    # Normalize persisted task links without rewriting historical files.
    for record in [status, *status.get("registrations", [])]:
        for field in ("status_url", "progress_url", "result_url"):
            value = record.get(field)
            if isinstance(value, str) and value.startswith("/api/v1/registrations/"):
                record[field] = value.replace("/api/v1/registrations/", "/api/v2/registrations/", 1)
    for model in ("a", "b"):
        dataset = status.get("inputs", {}).get(f"model_{model}_dataset", {})
        if dataset.get("format") not in {"lcc", "lcc2"}:
            continue
        gaussian_path = dataset.get("gaussian_path")
        if not gaussian_path:
            gaussian_path = dataset.get("dataset_entrypoint")
            dataset.update(
                gaussian_path=gaussian_path,
                gaussian_direct_path=gaussian_path,
                gaussian_status="ready",
                gaussian_stage="ready",
            )
        if not dataset.get("gaussian_cache_status"):
            cached = str(gaussian_path).endswith("lod-meta.json") and "-streamed/" in str(gaussian_path)
            dataset["gaussian_cache_status"] = "ready" if cached else "not_requested"
        if gaussian_path and status.get("preview_access_token"):
            status[f"gaussian_{model}_url"] = (
                f"/gaussian-resources/{status['session_id']}/{status['preview_access_token']}/{model}/{gaussian_path}"
            )
            status[f"gaussian_{model}_filename"] = Path(gaussian_path).name
    return status


def reconcile_gaussian_caches(session_directory: Path, status: dict[str, Any]) -> bool:
    """Repair persisted cache state after an interrupted process without rebuilding valid data."""
    changed = False
    for model in ("a", "b"):
        dataset = status.get("inputs", {}).get(f"model_{model}_dataset")
        if not isinstance(dataset, dict):
            continue
        cache_status = dataset.get("gaussian_cache_status", "not_requested")
        if cache_status not in {"queued", "converting", "ready"}:
            continue
        relative = dataset.get("gaussian_cache_path") or f"datasets/model-{model}-streamed/lod-meta.json"
        entrypoint = (session_directory / relative).resolve()
        try:
            entrypoint.relative_to(session_directory.resolve())
            validate_streamed_sog_directory(entrypoint)
            complete = True
        except (ValueError, DatasetFormatError):
            complete = False
        if complete:
            normalized = str(entrypoint.relative_to(session_directory.resolve())).replace("\\", "/")
            values = {
                "gaussian_cache_status": "ready", "gaussian_cache_progress": 100,
                "gaussian_cache_path": normalized, "gaussian_path": normalized,
            }
            if any(dataset.get(key) != value for key, value in values.items()):
                dataset.update(values)
                dataset.pop("gaussian_cache_error", None)
                changed = True
            token = status.get("preview_access_token")
            if token:
                url = f"/gaussian-resources/{status['session_id']}/{token}/{model}/{normalized}"
                if status.get(f"gaussian_{model}_url") != url:
                    status[f"gaussian_{model}_url"] = url
                    status[f"gaussian_{model}_filename"] = entrypoint.name
                    changed = True
        elif cache_status == "converting" or (
            cache_status == "ready" and dataset.get("gaussian_cache_requested")
        ):
            dataset.update(gaussian_cache_status="queued", gaussian_cache_progress=0)
            changed = True
    return changed


def source_available(session_directory: Path, status: dict[str, Any]) -> bool:
    return all(
        (session_directory / "input" / status.get(field, "")).is_file()
        for field in ("model_a_filename", "model_b_filename")
    )


def model_compute_path(session_directory: Path, status: dict[str, Any], model: str) -> Path:
    dataset = status.get("inputs", {}).get(f"model_{model}_dataset", {})
    relative = dataset.get("compute_path")
    return session_directory / relative if relative else session_directory / "input" / status[f"model_{model}_filename"]


def model_gaussian_path(session_directory: Path, status: dict[str, Any], model: str) -> Path | None:
    dataset = status.get("inputs", {}).get(f"model_{model}_dataset")
    if dataset is not None:
        relative = dataset.get("gaussian_path")
        return session_directory / relative if relative else None
    if status.get("metadata", {}).get(f"gaussian_{model}_available"):
        return session_directory / "input" / status[f"model_{model}_filename"]
    return None


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
