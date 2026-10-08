# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

from service.dataset_formats import DatasetFormatError, probe_dataset, validate_streamed_sog_directory
from service.dataset_preparation import _convert_to_ply, _convert_to_streamed_sog, _generate_streamed_sog, _safe_extract
from service.ply_coordinates import read_ply_coordinates


GAUSSIAN_FORMATS = {"gaussian_ply", "compressed_ply", "spz", "sog", "streamed_sog", "lcc", "lcc2"}


def preserve_streaming_cache(directory: Path, entrypoint: Path) -> str:
    """Keep reused encoded files independent from releasable source directories."""
    validate_streamed_sog_directory(entrypoint)
    output = directory / "output"
    if entrypoint.parent.resolve() != output.resolve():
        shutil.copytree(entrypoint.parent, output, dirs_exist_ok=True)
    destination = output / entrypoint.name
    validate_streamed_sog_directory(destination)
    return destination.relative_to(directory).as_posix()


def prepare_streaming_task(directory: Path, status: dict[str, Any], converter: list[str], worker: str) -> dict[str, Any]:
    """Prepare one model for preview without creating a registration session."""
    if status["input_kind"] == "lod_group":
        entrypoint = directory / status["lods"][-1]["path"]
        format_name = status["lods"][-1]["format"]
    else:
        source = directory / status["source_path"]
        probe = probe_dataset(source)
        format_name = probe.format
        if format_name not in GAUSSIAN_FORMATS:
            raise DatasetFormatError("Only supported Gaussian datasets can be streamed")
        if probe.container == "zip":
            workspace = directory / "datasets" / "source"
            _safe_extract(source, workspace)
            entrypoint = workspace / probe.entrypoint
        else:
            entrypoint = source
        status["dataset_entrypoint"] = entrypoint.relative_to(directory).as_posix()
    if not entrypoint.is_file():
        raise DatasetFormatError("Gaussian dataset entrypoint is missing")

    preview_input = entrypoint
    status["coordinate_metadata"] = read_ply_coordinates(entrypoint)
    if format_name != "gaussian_ply":
        preview_input = directory / "computed" / "preview-model.ply"
        options: list[str] = []
        if format_name in {"streamed_sog", "lcc", "lcc2"}:
            metadata = json.loads(entrypoint.read_text(encoding="utf-8-sig"))
            key = {"streamed_sog": "lodLevels", "lcc": "totalLevel", "lcc2": "totalLevels"}[format_name]
            levels = metadata.get(key)
            if not isinstance(levels, int) or levels < 1:
                raise DatasetFormatError("Dataset LOD count is invalid")
            options = ["--select-lod", str(levels - 1)]
        _convert_to_ply(entrypoint, preview_input, converter, subprocess.run, options)

    preview_directory = directory / "preview"
    result = subprocess.run(
        [worker, "prepare-single-model-preview", "--model", str(preview_input),
         "--output-dir", str(preview_directory), "--point-limit", "300000"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800, check=False,
    )
    metadata_path = preview_directory / "metadata.json"
    if result.returncode != 0 or not metadata_path.is_file():
        raise DatasetFormatError(result.stderr.strip() or "Single-model preview generation failed")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    status.update(
        metadata=metadata["model"],
        preview_url=f"/api/v2/streaming-tasks/{status['task_id']}/preview",
        gaussian_path=entrypoint.relative_to(directory).as_posix(),
        gaussian_filename=entrypoint.name,
        status="ready",
    )
    return status


def generate_streaming_cache(directory: Path, status: dict[str, Any], converter: list[str]) -> str:
    """Use supplied LODs as-is; derive LODs only for a single-layer source."""
    entrypoint = directory / status["dataset_entrypoint"] if status["input_kind"] != "lod_group" else None
    if entrypoint is not None and status["format"] == "streamed_sog":
        return preserve_streaming_cache(directory, entrypoint)

    output = directory / "output"
    if output.is_dir():
        shutil.rmtree(output)
    destination = output / "lod-meta.json"
    if status["input_kind"] == "lod_group":
        command = [*converter, "--overwrite", "--gpu", "cpu"]
        for level, item in enumerate(status["lods"]):
            command.extend([str(directory / item["path"]), "--tag-lod", str(level)])
        command.append(str(destination))
        output.mkdir(parents=True)
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8",
                                errors="replace", timeout=1800, check=False)
        error = result.stderr.strip() or result.stdout.strip() or "LOD group conversion failed"
        if result.returncode != 0:
            raise DatasetFormatError(error)
    elif status["format"] in {"lcc", "lcc2"}:
        error = _convert_to_streamed_sog(entrypoint, destination, converter, subprocess.run)
        if error:
            raise DatasetFormatError(error)
    else:
        source = entrypoint
        if status["format"] != "gaussian_ply":
            source = directory / "computed" / "full-gaussian.ply"
            _convert_to_ply(entrypoint, source, converter, subprocess.run)
        error = _generate_streamed_sog(source, destination, converter, subprocess.run)
        if error:
            raise DatasetFormatError(error)
    validate_streamed_sog_directory(destination)
    return destination.relative_to(directory).as_posix()
