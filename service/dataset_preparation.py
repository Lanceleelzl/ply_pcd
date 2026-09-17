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


def _ply_vertex_count(source: Path) -> int:
    with source.open("rb") as stream:
        header = stream.read(256 * 1024)
    end = header.find(b"end_header")
    if end < 0:
        raise DatasetFormatError("Gaussian PLY header is incomplete")
    for line in header[:end].decode("ascii", errors="strict").splitlines():
        parts = line.split()
        if len(parts) == 3 and parts[:2] == ["element", "vertex"]:
            count = int(parts[2])
            if count > 0:
                return count
    raise DatasetFormatError("Gaussian PLY has no positive vertex count")


def _generate_streamed_sog(source: Path, destination: Path, converter: list[str], run: RunCommand) -> str | None:
    build_directory = destination.parent.with_name(f"{destination.parent.name}-build")
    build_directory.mkdir(parents=True, exist_ok=True)
    count = _ply_vertex_count(source)
    targets: list[int] = []
    for ratio in (0.5, 0.25, 0.1):
        target = max(1, int(count * ratio))
        if target < count and target not in targets:
            targets.append(target)
    lods = [(str(target), build_directory / f"lod-{level}.ply")
            for level, target in enumerate(targets, start=1)]
    try:
        for target, path in lods:
            result = run(
                [*converter, "--overwrite", str(source), "--decimate", target, str(path)],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800, check=False,
            )
            if result.returncode != 0 or not path.is_file() or path.stat().st_size == 0:
                return result.stderr.strip() or result.stdout.strip() or f"exit code {result.returncode}"
        command = [*converter, "--overwrite", str(source), "--tag-lod", "0"]
        for level, (_, path) in enumerate(lods, start=1):
            command.extend([str(path), "--tag-lod", str(level)])
        command.append(str(destination))
        destination.parent.mkdir(parents=True, exist_ok=True)
        result = run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800, check=False)
        if result.returncode != 0 or not destination.is_file() or destination.stat().st_size == 0:
            return result.stderr.strip() or result.stdout.strip() or f"exit code {result.returncode}"
        return None
    finally:
        shutil.rmtree(build_directory, ignore_errors=True)


def _compute_lod(entrypoint: Path, format_name: str) -> int | None:
    if format_name not in {"streamed_sog", "lcc", "lcc2"}:
        return None
    metadata = json.loads(entrypoint.read_text(encoding="utf-8-sig"))
    count_key = {"streamed_sog": "lodLevels", "lcc": "totalLevel", "lcc2": "totalLevels"}[format_name]
    count = metadata.get(count_key)
    if not isinstance(count, int) or count <= 0:
        raise DatasetFormatError(f"Dataset {count_key} must be a positive integer")
    return count - 1


def prepare_model_dataset(session_directory: Path, model: str, source_filename: str,
                          probe: DatasetProbe, converter: list[str], *,
                          run: RunCommand = subprocess.run) -> tuple[Path, dict[str, Any]]:
    source = session_directory / "input" / source_filename
    if probe.format in {"ply", "gaussian_ply", "pcd", "las", "laz"}:
        prepared = {
            "compute_path": str(source.relative_to(session_directory)).replace("\\", "/"),
            "gaussian_path": str(source.relative_to(session_directory)).replace("\\", "/")
            if probe.gaussian_capable else None,
        }
        if probe.gaussian_capable:
            prepared["dataset_entrypoint"] = prepared["compute_path"]
            prepared["gaussian_cache_status"] = "not_requested"
        return source, prepared

    if probe.format == "spz":
        compute_path = session_directory / "computed" / f"model-{model}.ply"
        _convert_to_ply(source, compute_path, converter, run)
        return compute_path, {
            "compute_path": str(compute_path.relative_to(session_directory)).replace("\\", "/"),
            "gaussian_path": str(source.relative_to(session_directory)).replace("\\", "/"),
            "dataset_entrypoint": str(source.relative_to(session_directory)).replace("\\", "/"),
            "gaussian_cache_status": "not_requested",
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
    compute_lod = _compute_lod(entrypoint, probe.format)
    input_options = ["--select-lod", str(compute_lod)] if compute_lod is not None else []
    _convert_to_ply(entrypoint, compute_path, converter, run, input_options)
    if probe.format in {"sog", "streamed_sog"}:
        gaussian_path = entrypoint
    elif probe.format in {"compressed_ply"}:
        gaussian_path = source
    elif probe.format in {"lcc", "lcc2"}:
        gaussian_path = entrypoint
        gaussian_error = None
    else:
        gaussian_path = None
    prepared = {
        "compute_path": str(compute_path.relative_to(session_directory)).replace("\\", "/"),
        "gaussian_path": str(gaussian_path.relative_to(session_directory)).replace("\\", "/")
        if gaussian_path else None,
        "dataset_entrypoint": str(entrypoint.relative_to(session_directory)).replace("\\", "/"),
    }
    if compute_lod is not None:
        prepared["compute_lod"] = compute_lod
    if probe.format in {"compressed_ply", "sog", "lcc", "lcc2"}:
        prepared["gaussian_cache_status"] = "not_requested"
    if probe.format in {"lcc", "lcc2"}:
        prepared["gaussian_resource_tree"] = True
        prepared["gaussian_direct_path"] = prepared["gaussian_path"]
        prepared["gaussian_cache_status"] = "not_requested"
        if gaussian_error:
            prepared["gaussian_error"] = gaussian_error
    return compute_path, prepared


def prepare_session_datasets(session_directory: Path, status: dict[str, Any],
                             converter: list[str],
                             progress: Callable[[], None] | None = None) -> tuple[Path, Path]:
    inputs = status["inputs"]
    paths: dict[str, Path] = {}
    for model in ("a", "b"):
        dataset = inputs[f"model_{model}_dataset"]
        dataset.update(xyz_stage="preparing_compute", xyz_progress=20)
        if progress:
            progress()
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
        dataset.update(
            prepared,
            xyz_status="ready",
            xyz_stage="generating_preview",
            xyz_progress=75,
            gaussian_status=gaussian_status,
            gaussian_stage="waiting" if gaussian_status == "pending" else gaussian_status,
        )
        if progress:
            progress()
        paths[model] = path
    return paths["a"], paths["b"]


def prepare_gaussian_cache(
    session_directory: Path,
    status: dict[str, Any],
    converter: list[str],
    model: str,
    progress: Callable[[], None] | None = None,
    *,
    run: RunCommand = subprocess.run,
) -> None:
    dataset = status.get("inputs", {}).get(f"model_{model}_dataset", {})
    format_name = dataset.get("format")
    if format_name not in {"gaussian_ply", "compressed_ply", "spz", "sog", "lcc", "lcc2"}:
        raise DatasetFormatError("Only Gaussian models support streamed cache generation")
    dataset.update(gaussian_cache_status="converting", gaussian_cache_progress=None)
    if progress:
        progress()
    entrypoint_key = "dataset_entrypoint" if format_name in {"lcc", "lcc2"} else "compute_path"
    entrypoint = session_directory / dataset[entrypoint_key]
    if not entrypoint.is_file() and format_name not in {"lcc", "lcc2"}:
        source_relative = dataset.get("dataset_entrypoint")
        source = session_directory / source_relative if isinstance(source_relative, str) else None
        if source is not None and source.is_file():
            entrypoint = source
    destination = session_directory / "datasets" / f"model-{model}-streamed" / "lod-meta.json"
    error = (_convert_to_streamed_sog(entrypoint, destination, converter, run)
             if format_name in {"lcc", "lcc2"}
             else _generate_streamed_sog(entrypoint, destination, converter, run))
    if error:
        dataset.update(gaussian_cache_status="failed", gaussian_cache_error=error)
    else:
        relative = str(destination.relative_to(session_directory)).replace("\\", "/")
        dataset.update(
            gaussian_cache_status="ready",
            gaussian_cache_progress=100,
            gaussian_cache_path=relative,
            gaussian_path=relative,
        )
        status[f"gaussian_{model}_url"] = (
            f"/gaussian-resources/{status['session_id']}/{status['preview_access_token']}/{model}/{relative}"
        )
        status[f"gaussian_{model}_filename"] = destination.name
    if progress:
        progress()
