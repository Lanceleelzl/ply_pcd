# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

from pathlib import Path
from typing import Any


def archive_session_sources(store: Any, session_directory: Path, status: dict[str, Any]) -> None:
    if not store.enabled:
        return
    session_id = status["session_id"]
    objects: dict[str, str] = {}
    try:
        for model, field in (("a", "model_a_filename"), ("b", "model_b_filename")):
            filename = status[field]
            key = store.key("sessions", session_id, "input", filename)
            store.upload_file(session_directory / "input" / filename, key)
            objects[model] = key
    except Exception:
        store.delete_prefix(store.key("sessions", session_id) + "/")
        raise
    status["object_storage"] = {"backend": "s3", "source_available": True, "sources": objects}


def restore_session_sources(store: Any, session_directory: Path, status: dict[str, Any]) -> bool:
    if all((session_directory / "input" / status.get(field, "")).is_file()
           for field in ("model_a_filename", "model_b_filename")):
        return True
    storage = status.get("object_storage", {})
    sources = storage.get("sources", {})
    if not store.enabled or not storage.get("source_available") or not all(sources.get(model) for model in ("a", "b")):
        return False
    for model, field in (("a", "model_a_filename"), ("b", "model_b_filename")):
        destination = session_directory / "input" / status[field]
        if not destination.is_file():
            store.download_file(sources[model], destination)
    return True


def source_available_locally_or_remotely(session_directory: Path, status: dict[str, Any]) -> bool:
    local = all((session_directory / "input" / status.get(field, "")).is_file()
                for field in ("model_a_filename", "model_b_filename"))
    return local or bool(status.get("object_storage", {}).get("source_available"))


def archive_job_result(store: Any, job_id: str, result_directory: Path) -> None:
    if not store.enabled:
        return
    for path in result_directory.iterdir():
        if path.is_file():
            store.upload_file(path, store.key("jobs", job_id, "result", path.name))


def restore_job_result(store: Any, job_id: str, filename: str, destination: Path) -> bool:
    if destination.is_file():
        return True
    if not store.enabled:
        return False
    store.download_file(store.key("jobs", job_id, "result", filename), destination)
    return True


def delete_session_objects(store: Any, status: dict[str, Any]) -> None:
    if not store.enabled:
        return
    session_id = status["session_id"]
    store.delete_prefix(store.key("sessions", session_id) + "/")
    for registration in [*status.get("registrations", []), *status.get("coarse_registrations", [])]:
        if registration.get("job_id"):
            store.delete_prefix(store.key("jobs", registration["job_id"]) + "/")
    status.setdefault("object_storage", {})["source_available"] = False
