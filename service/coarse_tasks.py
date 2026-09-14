# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import asyncio
import shutil
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any


async def run_coarse_registration_task(
    job_id: str,
    command: list[str],
    *,
    resolve_job_directory: Callable[[str], Path],
    read_status: Callable[[Path], dict[str, Any]],
    write_status: Callable[[Path, dict[str, Any]], None],
    sync_session_job: Callable[[dict[str, Any]], None],
    semaphore: asyncio.Semaphore,
    running_processes: dict[str, asyncio.subprocess.Process],
    timeout_seconds: int,
) -> None:
    job_directory = resolve_job_directory(job_id)
    async with semaphore:
        status = read_status(job_directory)
        if status.get("status") == "cancelled":
            shutil.rmtree(job_directory / "input", ignore_errors=True)
            return
        status.update(status="running", started_at_unix=time.time())
        write_status(job_directory, status)
        sync_session_job(status)
        try:
            process = await asyncio.create_subprocess_exec(
                *command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            running_processes[job_id] = process
            if read_status(job_directory).get("status") == "cancelled":
                process.kill()
            try:
                stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout_seconds)
            except asyncio.TimeoutError:
                process.kill()
                await process.communicate()
                status.update(status="failed", error_code="worker_timeout", error="Coarse registration timed out")
            else:
                (job_directory / "worker.stdout.log").write_bytes(stdout)
                (job_directory / "worker.stderr.log").write_bytes(stderr)
                current = read_status(job_directory)
                if current.get("status") == "cancelled":
                    status = current
                elif process.returncode != 0:
                    message = stderr.decode("utf-8", errors="replace").strip()
                    status.update(status="failed", error_code="worker_failed", worker_exit_code=process.returncode,
                                  error=message or "Coarse registration worker failed")
                elif not (job_directory / "result" / "coarse-registration.json").is_file():
                    status.update(status="failed", error_code="missing_result", error="Worker produced no coarse result")
                else:
                    status.update(status="succeeded", result_url=f"/api/v2/coarse-registrations/{job_id}/result")
        except Exception as error:
            current = read_status(job_directory)
            if current.get("status") == "cancelled":
                status = current
            else:
                status.update(status="failed", error_code="worker_start_failed", error=str(error))
        finally:
            running_processes.pop(job_id, None)
        status["finished_at_unix"] = time.time()
        write_status(job_directory, status)
        sync_session_job(status)
        shutil.rmtree(job_directory / "input", ignore_errors=True)
