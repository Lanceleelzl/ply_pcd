# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import asyncio
import json
import shutil
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from service.transform_math import (
    business_transforms as _business_transforms,
    inverse_affine as _inverse_affine,
    matmul as _matmul,
    transform_matrix as _transform_matrix,
)


async def run_registration_task(
    job_id: str,
    command: list[str],
    *,
    resolve_job_directory: Callable[[str], Path],
    session_directory: Callable[[str], Path],
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
        status["status"] = "running"
        status["started_at_unix"] = time.time()
        write_status(job_directory, status)
        sync_session_job(status)
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            running_processes[job_id] = process
            if read_status(job_directory).get("status") == "cancelled":
                process.kill()
            async def read_stdout() -> bytes:
                chunks: list[bytes] = []
                progress_path = job_directory / "progress.ndjson"
                while line := await process.stdout.readline():
                    chunks.append(line)
                    try:
                        event = json.loads(line.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        continue
                    if event.get("type") == "iteration":
                        with progress_path.open("a", encoding="utf-8") as progress_output:
                            progress_output.write(json.dumps(event, separators=(",", ":")) + "\n")
                return b"".join(chunks)
            try:
                stdout, stderr, _ = await asyncio.wait_for(
                    asyncio.gather(read_stdout(), process.stderr.read(), process.wait()),
                    timeout=timeout_seconds,
                )
            except asyncio.TimeoutError:
                process.kill()
                await process.communicate()
                status.update(status="failed", error_code="worker_timeout", error="Registration timed out")
                status["finished_at_unix"] = time.time()
                write_status(job_directory, status)
                sync_session_job(status)
                shutil.rmtree(job_directory / "input", ignore_errors=True)
                return

            (job_directory / "worker.stdout.log").write_bytes(stdout)
            (job_directory / "worker.stderr.log").write_bytes(stderr)
            current_status = read_status(job_directory)
            if current_status.get("status") == "cancelled":
                status = current_status
            elif process.returncode != 0:
                message = stderr.decode("utf-8", errors="replace").strip()
                status.update(
                    status="failed",
                    error_code="worker_failed",
                    worker_exit_code=process.returncode,
                    error=message or "Registration worker failed",
                )
            else:
                result_path = job_directory / "result" / "registration.json"
                if not result_path.is_file():
                    status.update(status="failed", error_code="missing_result", error="Worker produced no result")
                else:
                    session_status = (read_status(session_directory(status["manual_session_id"]))
                                      if status.get("manual_session_id") else {})
                    if session_status.get("api_version") == "v2":
                        transforms = _business_transforms(session_status)
                        pa, pb = _transform_matrix(transforms["a"]), _transform_matrix(transforms["b"])
                        result = json.loads(result_path.read_text(encoding="utf-8"))
                        result["business_transforms"] = {"a": {"parameters": transforms["a"], "matrix": pa}, "b": {"parameters": transforms["b"], "matrix": pb}}
                        if status.get("coordinate_space") == "business":
                            result["coordinate_space"] = "business"
                            result["file_a_to_b"] = _matmul(_inverse_affine(pb), _matmul(result["a_to_b"], pa))
                            result["file_b_to_a"] = _inverse_affine(result["file_a_to_b"])
                        else:
                            result["coordinate_space"] = "file"
                            result["file_a_to_b"], result["file_b_to_a"] = result["a_to_b"], result["b_to_a"]
                            result["a_to_b"] = _matmul(pb, _matmul(result["file_a_to_b"], _inverse_affine(pa)))
                            result["b_to_a"] = _inverse_affine(result["a_to_b"])
                        direction = result.get("output_direction", session_status.get("output_direction", "a_to_b"))
                        source, target = ("a", "b") if direction == "a_to_b" else ("b", "a")
                        result["recommended_matrix"] = {"name": f"T_business_{direction}", "formula": f"p_business_{target} = T_business_{direction} * p_business_{source}", "value": result[direction]}
                        for name in ("file_a_to_b", "file_b_to_a", "a_to_b", "b_to_a"):
                            (result_path.parent / f"{name}_matrix.txt").write_text(
                                "\n".join(" ".join(f"{value:.17g}" for value in row) for row in result[name]) + "\n",
                                encoding="utf-8",
                            )
                        result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
                    status.update(status="succeeded", result_url=f"/api/v1/registrations/{job_id}/result")
        except Exception as error:  # Keep API alive if worker startup itself fails.
            current_status = read_status(job_directory)
            if current_status.get("status") == "cancelled":
                status = current_status
            else:
                status.update(status="failed", error_code="worker_start_failed", error=str(error))
        finally:
            running_processes.pop(job_id, None)
        status["finished_at_unix"] = time.time()
        write_status(job_directory, status)
        sync_session_job(status)
        shutil.rmtree(job_directory / "input", ignore_errors=True)
