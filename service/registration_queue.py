# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import json
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any


StatusReader = Callable[[Path], dict[str, Any]]
StatusWriter = Callable[[Path, dict[str, Any]], None]
TaskStarter = Callable[[str, list[str]], Any]


def write_task_descriptor(job_directory: Path, command: list[str]) -> None:
    if not command or not all(isinstance(argument, str) and argument for argument in command):
        raise ValueError("Registration command must contain non-empty strings")
    temporary = job_directory / "task.json.tmp"
    temporary.write_text(
        json.dumps({"version": 1, "command": command}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    temporary.replace(job_directory / "task.json")


def read_task_descriptor(job_directory: Path) -> list[str]:
    descriptor = json.loads((job_directory / "task.json").read_text(encoding="utf-8"))
    command = descriptor.get("command") if descriptor.get("version") == 1 else None
    if not isinstance(command, list) or not command or not all(
        isinstance(argument, str) and argument for argument in command
    ):
        raise ValueError("Invalid registration task descriptor")
    return command


def recover_registration_queue(
    runtime_root: Path,
    *,
    read_status: StatusReader,
    write_status: StatusWriter,
    sync_session_job: Callable[[dict[str, Any]], None],
    start_registration: TaskStarter,
    now: Callable[[], float] = time.time,
) -> dict[str, int]:
    counts = {"requeued": 0, "failed": 0, "ignored": 0}
    jobs_directory = runtime_root / "jobs"
    if not jobs_directory.is_dir():
        return counts

    def settle(job_directory: Path, status: dict[str, Any]) -> None:
        write_status(job_directory, status)
        try:
            sync_session_job(status)
        except Exception:
            # A retained Job must not prevent startup when its session was already removed.
            pass

    for job_directory in sorted(path for path in jobs_directory.iterdir() if path.is_dir()):
        try:
            status = read_status(job_directory)
        except Exception:
            continue
        state = status.get("status")
        if state == "queued":
            try:
                command = read_task_descriptor(job_directory)
            except (OSError, ValueError, json.JSONDecodeError):
                status.update(
                    status="failed",
                    error_code="queue_descriptor_invalid",
                    error="Queued registration task cannot be recovered",
                    finished_at_unix=now(),
                )
                settle(job_directory, status)
                counts["failed"] += 1
                continue
            try:
                start_registration(status.get("job_id", job_directory.name), command)
            except Exception as error:
                status.update(
                    status="failed",
                    error_code="queue_start_failed",
                    error=f"Registration task could not be scheduled: {error}",
                    finished_at_unix=now(),
                )
                settle(job_directory, status)
                counts["failed"] += 1
                continue
            counts["requeued"] += 1
        elif state == "running":
            status.update(
                status="failed",
                error_code="service_restarted",
                error="Registration was interrupted by a service restart",
                finished_at_unix=now(),
            )
            settle(job_directory, status)
            counts["failed"] += 1
        else:
            counts["ignored"] += 1
    return counts
