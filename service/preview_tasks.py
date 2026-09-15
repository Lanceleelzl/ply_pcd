# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from service.dataset_formats import DatasetFormatError


SessionDirectory = Callable[[str], Path]
StatusReader = Callable[[Path], dict[str, Any]]
StatusWriter = Callable[[Path, dict[str, Any]], None]


async def run_preview_task(
    session_id: str,
    command: list[str],
    session_directory: SessionDirectory,
    read_status: StatusReader,
    write_status: StatusWriter,
    semaphore: asyncio.Semaphore,
    timeout_seconds: int,
    prepare_datasets: Callable[[Path, dict[str, Any]], tuple[Path, Path]] | None = None,
) -> None:
    directory = session_directory(session_id)
    status = read_status(directory)
    async with semaphore:
        status["status"] = "preparing"
        status["started_at_unix"] = time.time()
        write_status(directory, status)
        try:
            if prepare_datasets is not None:
                model_a, model_b = await asyncio.to_thread(prepare_datasets, directory, status)
                command[command.index("--model-a") + 1] = str(model_a)
                command[command.index("--model-b") + 1] = str(model_b)
                write_status(directory, status)
            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout_seconds)
            (directory / "worker.stdout.log").write_bytes(stdout)
            (directory / "worker.stderr.log").write_bytes(stderr)
            if process.returncode != 0:
                message = stderr.decode("utf-8", errors="replace").strip()
                status.update(status="failed", error_code="preview_worker_failed", error=message)
            else:
                metadata_path = directory / "preview" / "metadata.json"
                if not metadata_path.is_file():
                    status.update(status="failed", error_code="missing_preview", error="Worker produced no preview")
                else:
                    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                    for model in ("a", "b"):
                        dataset = status.get("inputs", {}).get(f"model_{model}_dataset")
                        if dataset is not None:
                            metadata[f"gaussian_{model}_available"] = bool(dataset.get("gaussian_path"))
                    status.update(status="ready", metadata=metadata)
                    status.update(
                        model_a_preview_url=f"/api/v2/registration-sessions/{session_id}/preview/model-a",
                        model_b_preview_url=f"/api/v2/registration-sessions/{session_id}/preview/model-b",
                    )
                    if metadata.get("gaussian_a_available"):
                        gaussian_path = status.get("inputs", {}).get("model_a_dataset", {}).get("gaussian_path")
                        status["gaussian_a_url"] = (
                            f"/gaussian-resources/{session_id}/{status['preview_access_token']}/a/{gaussian_path}"
                            if gaussian_path else f"/api/v2/registration-sessions/{session_id}/preview/gaussian-a"
                        )
                        status["gaussian_a_filename"] = Path(gaussian_path).name if gaussian_path else status["model_a_filename"]
                    if metadata.get("gaussian_b_available"):
                        gaussian_path = status.get("inputs", {}).get("model_b_dataset", {}).get("gaussian_path")
                        status["gaussian_b_url"] = (
                            f"/gaussian-resources/{session_id}/{status['preview_access_token']}/b/{gaussian_path}"
                            if gaussian_path else f"/api/v2/registration-sessions/{session_id}/preview/gaussian-b"
                        )
                        status["gaussian_b_filename"] = Path(gaussian_path).name if gaussian_path else status["model_b_filename"]
        except DatasetFormatError as error:
            for model in ("a", "b"):
                dataset = status.get("inputs", {}).get(f"model_{model}_dataset")
                if dataset is not None and dataset.get("xyz_status") == "pending":
                    dataset["xyz_status"] = "failed"
            status.update(status="failed", error_code="dataset_preparation_failed", error=str(error))
        except asyncio.TimeoutError:
            process.kill()
            await process.communicate()
            status.update(status="failed", error_code="preview_timeout", error="Preview generation timed out")
        except Exception as error:
            status.update(status="failed", error_code="preview_start_failed", error=str(error))
        status["finished_at_unix"] = time.time()
        write_status(directory, status)
