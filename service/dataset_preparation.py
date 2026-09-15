# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import shutil
import subprocess
import zipfile
import os
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

from service.dataset_formats import DatasetFormatError, DatasetProbe
from service.dataset_formats import MAX_DATASET_FILES, MAX_DATASET_UNCOMPRESSED_BYTES, MAX_ZIP_COMPRESSION_RATIO


RunCommand = Callable[..., subprocess.CompletedProcess[str]]


def _ensure_lcc_companion_names(entrypoint: Path, quality: bool) -> None:
    expected = ["index.bin", "data.bin", *(["shcoef.bin"] if quality else [])]
    siblings = {path.name.lower(): path for path in entrypoint.parent.iterdir() if path.is_file()}
    for name in expected:
        canonical = entrypoint.parent / name
        source = siblings.get(name)
        if canonical.is_file():
            continue
        if source is None:
            raise DatasetFormatError(f"LCC dataset is missing required companion: {name}")
        try:
            os.link(source, canonical)
        except OSError as error:
            raise DatasetFormatError(f"Cannot create canonical LCC companion name: {name}") from error


def _safe_extract(source: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    root = destination.resolve()
    with zipfile.ZipFile(source) as archive:
        infos = archive.infolist()
        files = [info for info in infos if not info.is_dir()]
        total_size = sum(info.file_size for info in files)
        compressed_size = sum(max(info.compress_size, 1) for info in files)
        if len(files) > MAX_DATASET_FILES or total_size > MAX_DATASET_UNCOMPRESSED_BYTES or total_size > compressed_size * MAX_ZIP_COMPRESSION_RATIO:
            raise DatasetFormatError("Dataset ZIP exceeds extraction safety limits")
        if any((info.external_attr >> 16) & 0o170000 == 0o120000 for info in infos):
            raise DatasetFormatError("Dataset ZIP symbolic links are not supported")
        for info in infos:
            target = (destination / Path(info.filename.replace("\\", "/"))).resolve()
            if root != target and root not in target.parents:
                raise DatasetFormatError(f"Unsafe dataset path: {info.filename}")
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as input_stream, target.open("wb") as output_stream:
                shutil.copyfileobj(input_stream, output_stream)


def _convert_to_ply(entrypoint: Path, destination: Path, converter: list[str], run: RunCommand,
                    input_options: list[str] | None = None) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    result = run([*converter, "--overwrite", *(input_options or []), str(entrypoint), str(destination)], capture_output=True,
                 text=True, encoding="utf-8", errors="replace", timeout=1800, check=False)
    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip() or f"exit code {result.returncode}"
        raise DatasetFormatError(f"Dataset XYZ conversion failed: {message}")
    if not destination.is_file() or destination.stat().st_size == 0:
        raise DatasetFormatError("Dataset XYZ conversion produced no PLY file")


def _convert_to_streamed_sog(entrypoint: Path, destination: Path, converter: list[str], run: RunCommand) -> str | None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    result = run([*converter, "--overwrite", str(entrypoint), str(destination)], capture_output=True,
                 text=True, encoding="utf-8", errors="replace", timeout=1800, check=False)
    if result.returncode != 0 or not destination.is_file() or destination.stat().st_size == 0:
        return result.stderr.strip() or result.stdout.strip() or f"exit code {result.returncode}"
    return None


def prepare_model_dataset(session_directory: Path, model: str, source_filename: str,
                          probe: DatasetProbe, converter: list[str], *,
                          run: RunCommand = subprocess.run) -> tuple[Path, dict[str, Any]]:
    source = session_directory / "input" / source_filename
    if probe.format in {"ply", "gaussian_ply", "pcd", "las", "laz"}:
        return source, {
            "compute_path": str(source.relative_to(session_directory)).replace("\\", "/"),
            "gaussian_path": str(source.relative_to(session_directory)).replace("\\", "/")
            if probe.gaussian_capable else None,
        }

    workspace = session_directory / "datasets" / f"model-{model}"
    if probe.container == "zip":
        _safe_extract(source, workspace)
        entrypoint = workspace / probe.entrypoint
    else:
        entrypoint = source
    if not entrypoint.is_file():
        raise DatasetFormatError(f"Dataset entrypoint is missing: {probe.entrypoint}")
    if probe.format == "lcc":
        metadata = json.loads(entrypoint.read_text(encoding="utf-8"))
        _ensure_lcc_companion_names(entrypoint, metadata.get("fileType") == "Quality")
    compute_path = session_directory / "computed" / f"model-{model}.ply"
    input_options = ["--select-lod", "0"] if probe.format in {"streamed_sog", "lcc", "lcc2"} else []
    _convert_to_ply(entrypoint, compute_path, converter, run, input_options)
    if probe.format in {"sog", "streamed_sog"}:
        gaussian_path = entrypoint
    elif probe.format in {"compressed_ply"}:
        gaussian_path = source
    elif probe.format in {"lcc", "lcc2"}:
        gaussian_path = session_directory / "datasets" / f"model-{model}-streamed" / "lod-meta.json"
        gaussian_error = _convert_to_streamed_sog(entrypoint, gaussian_path, converter, run)
        if gaussian_error:
            gaussian_path = None
    else:
        gaussian_path = None
    prepared = {
        "compute_path": str(compute_path.relative_to(session_directory)).replace("\\", "/"),
        "gaussian_path": str(gaussian_path.relative_to(session_directory)).replace("\\", "/")
        if gaussian_path else None,
        "dataset_entrypoint": str(entrypoint.relative_to(session_directory)).replace("\\", "/"),
    }
    if probe.format in {"lcc", "lcc2"}:
        prepared["gaussian_resource_tree"] = True
        if gaussian_error:
            prepared["gaussian_error"] = gaussian_error
    return compute_path, prepared


def prepare_session_datasets(session_directory: Path, status: dict[str, Any],
                             converter: list[str]) -> tuple[Path, Path]:
    inputs = status["inputs"]
    paths: dict[str, Path] = {}
    for model in ("a", "b"):
        path, prepared = prepare_model_dataset(
            session_directory, model, status[f"model_{model}_filename"],
            DatasetProbe(**{
                key: value for key, value in inputs[f"model_{model}_dataset"].items()
                if key in DatasetProbe.__dataclass_fields__
            }), converter,
        )
        gaussian_status = "ready" if prepared.get("gaussian_path") else (
            "failed" if prepared.get("gaussian_error") else "not_available"
        )
        inputs[f"model_{model}_dataset"].update(prepared, xyz_status="ready", gaussian_status=gaussian_status)
        paths[model] = path
    return paths["a"], paths["b"]
