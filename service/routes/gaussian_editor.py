# SPDX-License-Identifier: GPL-3.0-or-later
"""Independent Gaussian editor tasks and non-destructive per-LOD results."""
from __future__ import annotations

import asyncio
import hmac
import json
import math
import secrets
import subprocess
import time
import uuid
import zipfile
from functools import lru_cache
from hashlib import file_digest
from pathlib import Path
from typing import Annotated, Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from pyproj import CRS
from pyproj.exceptions import CRSError

from service.auth import current_principal
from service.dataset_formats import DatasetFormatError, probe_dataset, validate_streamed_sog_directory
from service.dataset_preparation import _convert_to_ply, _ply_vertex_count
from service.gaussian_editor_rules import clip_ply, convert_ascii_gaussian_ply, validate_rules
from service.geographic_query import GeographicOrigin, GeographicQuery, project_origin, query_coordinates
from service.gaussian_merge import read_layout
from service.ply_coordinates import read_model_coordinates, read_ply_coordinates
from service.routes.streaming import StreamingTasks
from service.schemas import TransformParameters
from service.storage import read_status, workspace_id as parse_workspace_id, write_status
from service.streaming_zip import directory_zip_metadata, stream_directory_zip
from service.streaming_tasks import GAUSSIAN_FORMATS
from service.transform_math import transform_matrix
from service.uploads import save_upload_directory_with_sha256, save_upload_with_sha256
from service.validation import validate_transform


class ClipPlane(BaseModel):
    visible: bool
    side: Literal[-1, 1]


class DisplayClip(BaseModel):
    mode: Literal["off", "axis", "box"]
    min: tuple[float, float, float]
    max: tuple[float, float, float]
    center: tuple[float, float, float]
    size: tuple[float, float, float]
    planes: dict[Literal["xoy", "xoz", "yoz"], ClipPlane]


class DecimationSelection(BaseModel):
    version: str
    level: int = Field(ge=0)
    target_count: int = Field(gt=0)
    retain_percent: float | None = Field(default=None, gt=0, lt=100, allow_inf_nan=False)


class EditState(BaseModel):
    rules: list[dict[str, Any]] = Field(default_factory=list)
    selected_lods: list[int] = Field(default_factory=list)
    same_local_frame_confirmed: bool = False
    geography: dict[str, Any] | None = None
    transform: TransformParameters = Field(default_factory=TransformParameters)
    display_clip: DisplayClip | None = None
    decimation: DecimationSelection | None = None


class EditChange(BaseModel):
    label: str = Field(min_length=1, max_length=100)
    state: EditState


class ProcessRequest(BaseModel):
    levels: list[int] = Field(min_length=1)


class DecimateRequest(BaseModel):
    level: int = Field(ge=0)
    target_count: int = Field(gt=0)
    retain_percent: float | None = Field(default=None, gt=0, lt=100, allow_inf_nan=False)


class ExportRequest(BaseModel):
    version: str
    level: int = Field(ge=0)
    format: Literal["compressed_ply", "sog"]


class StreamedExportRequest(BaseModel):
    version: str


def lod_coordinate_frame(hints: dict[str, Any]) -> tuple:
    return (hints["epsg"], *(tuple(float(value) if value is not None else None for value in hints[key])
                             for key in ("offset", "shift", "scale")))


def lod_frames_conflict(first: tuple, second: tuple) -> bool:
    for left, right in zip((first[0], *first[1], *first[2], *first[3]),
                           (second[0], *second[1], *second[2], *second[3])):
        if left not in (None, "") and right not in (None, "") and left != right:
            return True
    return False


def lod_frame_complete(frame: tuple) -> bool:
    return bool(frame[0]) and all(value is not None for values in frame[1:] for value in values)


def output_coordinate_comments(source: Path, geography: dict[str, Any] | None,
                               identity_transform: bool, source_format: str = "gaussian_ply"
                               ) -> tuple[str, dict[str, str] | None]:
    if geography is None and identity_transform:
        return ("manifest", None) if source_format in {"lcc", "lcc2"} else ("source", None)
    if geography is None or not identity_transform:
        return "manifest", None
    hints = read_ply_coordinates(source)
    if (geography["axes"] != [1, 2, 3] or not math.isclose(geography["metres_per_unit"], 1)
            or any(value is not None and not math.isclose(float(value), 0) for value in hints["shift"])
            or any(value is not None and not math.isclose(float(value), 1) for value in hints["scale"])):
        return "manifest", None
    try:
        crs = CRS.from_epsg(geography["source_epsg"])
        axes = crs.axis_info[:2]
        if (not crs.is_projected or len(axes) != 2
                or [axis.direction for axis in axes] != ["east", "north"]
                or any(not math.isclose(axis.unit_conversion_factor, 1) for axis in axes)):
            return "manifest", None
    except (CRSError, ValueError, TypeError):
        return "manifest", None
    offsets = [geography["projected_origin"][index] - geography["reference"][index]
               for index in range(3)]
    comments = {"epsg": str(geography["source_epsg"]),
                **{f"offset{axis}": f"{offsets[index]:.17g}" for index, axis in enumerate("xyz")},
                **{f"shift{axis}": "0" for axis in "xyz"},
                **{f"scale{axis}": "1" for axis in "xyz"}}
    return "embedded", comments


def geography_from_result_manifest(manifest: dict[str, Any], digest: str,
                                   format_name: str, count: int, size: int) -> dict[str, Any]:
    if not isinstance(manifest.get("result_file_sha256"), str):
        raise ValueError("坐标说明缺少文件校验值，请从原任务重新下载")
    if (manifest.get("result_format") != format_name or manifest.get("result_gaussians") != count
            or manifest.get("result_file_bytes") != size
            or not hmac.compare_digest(manifest["result_file_sha256"], digest)):
        raise ValueError("坐标说明与上传模型的格式、数量或文件校验值不一致")
    if manifest.get("coordinate_mode") not in {"source", "embedded"}:
        raise ValueError("此坐标说明的地理框架不能自动还原，请在任务中手动设置")
    hints = manifest.get("result_ply_coordinate_hints")
    if not isinstance(hints, dict):
        raise ValueError("坐标说明缺少成果 PLY 坐标信息")
    try:
        epsg = int(hints["epsg"])
        offset = [float(value) for value in hints["offset"]]
        shift = [float(value) for value in hints["shift"]]
        scale = [float(value) for value in hints["scale"]]
        crs = CRS.from_epsg(epsg)
        axes = crs.axis_info[:2]
        if (len(offset) != 3 or len(shift) != 3 or len(scale) != 3
                or not all(math.isfinite(value) for value in (*offset, *shift, *scale))
                or not all(math.isclose(value, 0) for value in shift)
                or not all(math.isclose(value, 1) for value in scale)
                or not crs.is_projected or len(axes) != 2
                or [axis.direction for axis in axes] != ["east", "north"]
                or any(not math.isclose(axis.unit_conversion_factor, 1) for axis in axes)):
            raise ValueError
    except (KeyError, TypeError, ValueError, CRSError) as error:
        raise ValueError("坐标说明缺少可安全还原的米制投影框架") from error
    return {"reference": [0, 0, 0], "projected_origin": offset,
            "axes": [1, 2, 3], "metres_per_unit": 1, "source_epsg": epsg}


def exported_gaussian_count(path: Path, format_name: str, entrypoint: str) -> int:
    if format_name == "sog":
        with zipfile.ZipFile(path) as archive:
            count = json.loads(archive.read(entrypoint)).get("count")
            if archive.testzip() is not None:
                raise ValueError("SOG 压缩包校验失败")
    else:
        with path.open("rb") as stream:
            header = stream.read(256 * 1024)
        marker = header.find(b"end_header\n")
        if marker < 0:
            raise ValueError("Compressed PLY 头文件不完整")
        data_start = marker + len(b"end_header\n")
        type_bytes = {"char": 1, "uchar": 1, "short": 2, "ushort": 2,
                      "int": 4, "uint": 4, "float": 4, "double": 8}
        elements: list[list[int]] = []
        for line in header[:marker].decode("ascii").splitlines():
            fields = line.split()
            if fields[:2] == ["element", "chunk"] or fields[:2] == ["element", "vertex"]:
                elements.append([int(fields[2]), 0])
            elif fields[:1] == ["property"] and elements:
                if len(fields) != 3 or fields[1] not in type_bytes:
                    raise ValueError("Compressed PLY 含有不支持的属性")
                elements[-1][1] += type_bytes[fields[1]]
        counts = [int(line.split()[2]) for line in header[:marker].splitlines()
                  if line.startswith(b"element vertex ")]
        count = counts[0] if len(counts) == 1 and len(elements) == 2 else None
        if any(item[0] < 0 or item[1] <= 0 for item in elements) or (
                data_start + sum(item[0] * item[1] for item in elements) != path.stat().st_size):
            raise ValueError("Compressed PLY 数据长度与头文件不一致")
    if type(count) is not int or count < 0:
        raise ValueError("导出成果缺少有效的高斯数量")
    return count


def streamed_sog_level_counts(metadata: dict[str, Any]) -> list[int]:
    levels = metadata.get("lodLevels")
    if type(levels) is not int or not 0 < levels <= 128:
        raise ValueError("Streamed SOG 的 LOD 数量无效")
    counts = [0] * levels
    pending = [metadata["tree"]]
    while pending:
        node = pending.pop()
        pending.extend(node.get("children") or [])
        for level, item in (node.get("lods") or {}).items():
            index = int(level)
            if 0 <= index < levels:
                counts[index] += item["count"]
    return counts


@lru_cache(maxsize=32)
def read_streamed_sog_level_counts(entrypoint: Path) -> tuple[int, ...]:
    metadata = json.loads(entrypoint.read_text(encoding="utf-8-sig"))
    return tuple(streamed_sog_level_counts(metadata))


def validate_streamed_editor_levels(directory: Path, levels: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ordered = sorted(levels, key=lambda item: item["level"])
    if not ordered or [item["level"] for item in ordered] != list(range(ordered[0]["level"], ordered[-1]["level"] + 1)):
        raise ValueError("流式生成要求成果 LOD 连续")
    first = None
    previous_count = None
    for item in ordered:
        path = directory / item["path"]
        if not path.is_file():
            raise ValueError(f"LOD {item['level']} 成果文件缺失")
        layout = read_layout(path)
        if layout.count != item["count"] or layout.count <= 0 or path.stat().st_size != layout.data_start + layout.count * layout.stride:
            raise ValueError(f"LOD {item['level']} 成果文件不完整")
        fields = sorted((name, kind) for name, kind, _ in layout.fields)
        if first and (fields != first[0] or layout.epsg != first[1] or layout.offset != first[2]):
            raise ValueError("成果层级间属性或地理原点不一致")
        if previous_count is not None and layout.count > previous_count:
            raise ValueError("成果 LOD 点数不符合精细到粗略顺序")
        first = first or (fields, layout.epsg, layout.offset)
        previous_count = layout.count
    return ordered


class EditorTasks(StreamingTasks):
    def __init__(self, runtime_root: Path, converter: list[str], worker: str, retention_hours: int) -> None:
        super().__init__(runtime_root, converter, worker, retention_hours)
        self.root = runtime_root / "gaussian-editor-tasks"

    def present(self, status: dict[str, Any]) -> dict[str, Any]:
        result = dict(status)
        task_id, token = status["task_id"], status["resource_token"]
        if status.get("format") in {"lcc", "lcc2"} and status.get("dataset_entrypoint"):
            entrypoint = self.directory(task_id) / status["dataset_entrypoint"]
            if entrypoint.is_file():
                result["coordinate_metadata"] = read_model_coordinates(entrypoint)
                metadata = json.loads(entrypoint.read_text(encoding="utf-8-sig"))
                counts = metadata.get("splats" if status["format"] == "lcc" else "lodSplats")
                if isinstance(counts, list) and all(type(value) is int and value >= 0 for value in counts):
                    result["level_counts"] = counts
        if status.get("format") == "streamed_sog" and status.get("dataset_entrypoint"):
            entrypoint = self.directory(task_id) / status["dataset_entrypoint"]
            if entrypoint.is_file():
                result["level_counts"] = read_streamed_sog_level_counts(entrypoint)
        prefix = f"/gaussian-editor-resources/{task_id}/{token}/"
        result["preview_url"] = f"/api/v2/gaussian-editor-tasks/{task_id}/preview" if status.get("status") == "ready" else None
        result["gaussian_url"] = prefix + status["gaussian_path"] if status.get("gaussian_path") else None
        result["lods"] = [dict(item, gaussian_url=prefix + item["path"]) for item in status.get("lods", [])]
        result["derived_lods"] = [dict(item, gaussian_url=prefix + item["path"])
                                  for item in status.get("derived_lods", [])]
        result["available_levels"] = self.levels(status, self.directory(task_id))
        return result

    def recover(self) -> None:
        super().recover()
        if not self.root.is_dir():
            return
        for directory in self.root.iterdir():
            if not directory.is_dir() or not (directory / "status.json").is_file():
                continue
            status = read_status(directory)
            changed = False
            for operation in ("process", "decimate", "export", "streamed_export"):
                if status.get(f"{operation}_status") in {"queued", "running"}:
                    status[f"{operation}_status"] = "failed"
                    status[f"{operation}_error"] = "服务重启中断了处理；原始文件和已完成成果已保留，请重新提交"
                    changed = True
            if changed:
                write_status(directory, status)

    @staticmethod
    def levels(status: dict[str, Any], directory: Path) -> list[int]:
        if status.get("input_kind") == "lod_group":
            return [item["level"] for item in status.get("lods", [])]
        if status.get("format") in {"lcc", "lcc2", "streamed_sog"}:
            relative = status.get("dataset_entrypoint")
            if not relative:
                return []
            metadata = json.loads((directory / relative).read_text(encoding="utf-8-sig"))
            key = {"lcc": "totalLevel", "lcc2": "totalLevels", "streamed_sog": "lodLevels"}[status["format"]]
            count = metadata.get(key)
            return list(range(count)) if isinstance(count, int) and 0 < count <= 128 else []
        return [0]

    def source_for_level(self, directory: Path, status: dict[str, Any], level: int, workspace: Path) -> Path:
        if level not in self.levels(status, directory):
            raise ValueError("所选 LOD 不存在")
        if status["input_kind"] == "lod_group":
            item = next(item for item in status["lods"] if item["level"] == level)
            source = directory / item["path"]
            format_name = item["format"]
        else:
            source = directory / status["dataset_entrypoint"]
            format_name = status["format"]
        if format_name == "gaussian_ply":
            with source.open("rb") as stream:
                if b"format binary_little_endian" in stream.read(256):
                    return source
            destination = workspace / f"source-lod-{level}.ply"
            convert_ascii_gaussian_ply(source, destination)
            return destination
        if level == max(self.levels(status, directory)):
            preview_source = directory / "computed" / "preview-model.ply"
            if preview_source.is_file():
                read_layout(preview_source)
                return preview_source
        destination = workspace / f"source-lod-{level}.ply"
        options = ["--select-lod", str(level)] if format_name in {"lcc", "lcc2", "streamed_sog"} else []
        _convert_to_ply(source, destination, self.converter, subprocess.run, options)
        return destination

    def start_process(self, task_id: str, levels: list[int], state: dict[str, Any], version: str) -> None:
        job = asyncio.create_task(self._process(task_id, levels, state, version))
        self.running[task_id] = job
        job.add_done_callback(lambda completed, key=task_id: self.running.pop(key, None))

    async def _process(self, task_id: str, levels: list[int], state: dict[str, Any], version: str) -> None:
        async with self.semaphore:
            directory = self.directory(task_id)
            status = read_status(directory)
            results: list[dict[str, Any]] = []
            workspace = directory / "results" / version
            try:
                status.update(process_status="running", process_phase="准备数据", process_level=None,
                              process_progress=None, process_error=None)
                write_status(directory, status)
                reference = None
                transform = state.get("transform") or TransformParameters().model_dump()
                matrix = transform_matrix(transform)
                identity = transform == TransformParameters().model_dump()

                def to_common(point: tuple[float, float, float]) -> tuple[float, float, float]:
                    return tuple(sum(matrix[row][column] * point[column] for column in range(3))
                                 + matrix[row][3] for row in range(3))  # type: ignore[return-value]

                for index, level in enumerate(levels):
                    status.update(process_level=level, process_phase="转换输入", process_progress=None)
                    write_status(directory, status)
                    source = await asyncio.to_thread(self.source_for_level, directory, status, level, workspace)
                    layout = read_layout(source)
                    frame = lod_coordinate_frame(read_ply_coordinates(source))
                    if reference is not None and (lod_frames_conflict(frame, reference)
                                                  if status["input_kind"] == "lod_group" else frame != reference):
                        raise ValueError(f"LOD {level} 的 EPSG、投影原点、shift 或 scale 与其他层级不一致")
                    reference = frame
                    destination = workspace / f"lod-{level}.ply"
                    clipped = workspace / f"clipped-lod-{level}.ply" if not identity else destination
                    coordinate_mode, coordinate_comments = output_coordinate_comments(
                        source, state.get("geography"), identity, status["format"])
                    last_update = 0.0

                    def progress(done: int, total: int) -> None:
                        nonlocal last_update
                        now = time.monotonic()
                        if now - last_update < 0.3 and done < total:
                            return
                        last_update = now
                        status.update(process_phase="空间裁剪", process_progress=round(done * 100 / total, 1) if total else 100)
                        write_status(directory, status)

                    count = await asyncio.to_thread(clip_ply, source, clipped, state["rules"], progress,
                                                    to_common if not identity else None,
                                                    coordinate_mode != "source", coordinate_comments)
                    if not identity:
                        status.update(process_phase="模型整体变换", process_progress=None)
                        write_status(directory, status)
                        scale = transform["scale"][0]
                        rx, ry, rz = transform["rotation_degrees"]
                        tx, ty, tz = transform["translation"]
                        command = [*self.converter, str(clipped), "--scale", str(scale),
                                   "--rotate", f"{-rx},{-ry},{rz}",
                                   "--translate", f"{-tx},{-ty},{tz}", str(destination)]
                        converted = await asyncio.to_thread(subprocess.run, command, capture_output=True, text=True,
                                                            encoding="utf-8", errors="replace", timeout=7200, check=False)
                        if converted.returncode or not destination.is_file():
                            raise ValueError(converted.stderr.strip() or "模型整体变换失败")
                    result = {"level": level, "count": count, "source_count": layout.count,
                              "path": destination.relative_to(directory).as_posix(), "bytes": destination.stat().st_size,
                              "coordinate_mode": coordinate_mode}
                    status.update(process_phase="逐层校验", process_progress=100)
                    write_status(directory, status)
                    read_layout(destination)
                    output_hints = read_ply_coordinates(destination)
                    if coordinate_mode == "manifest" and (output_hints["epsg"] or any(
                            value is not None for value in output_hints["offset"])):
                        raise ValueError("成果仍包含旧投影注释，坐标导出已中止")
                    if coordinate_mode == "embedded" and (output_hints["epsg"] != coordinate_comments["epsg"]
                            or any(output_hints["offset"][axis] is None
                                   or not math.isclose(float(output_hints["offset"][axis]),
                                                    float(coordinate_comments[f"offset{'xyz'[axis]}"]), abs_tol=1e-6)
                                   for axis in range(3))):
                        raise ValueError("成果坐标原点写出校验失败")
                    results.append(result)
                    status.update(process_completed=index + 1, process_results=results)
                    write_status(directory, status)
                versions = status.get("versions", [])
                versions.append({"version": version, "created_at_unix": time.time(),
                                 "history_cursor": status["history_cursor"], "state": state,
                                 "levels": results})
                status.update(versions=versions, process_status="ready", process_phase="完成",
                              process_level=None, process_progress=100)
                write_status(directory, status)
            except Exception as error:
                status.update(process_status="failed", process_error=str(error), process_results=results,
                              process_level=None, process_progress=None)
                write_status(directory, status)

    def start_decimate(self, task_id: str, level: int, target_count: int, version: str) -> None:
        job = asyncio.create_task(self._decimate(task_id, level, target_count, version))
        self.running[task_id] = job
        job.add_done_callback(lambda completed, key=task_id: self.running.pop(key, None))

    async def _decimate(self, task_id: str, level: int, target_count: int, version: str) -> None:
        async with self.semaphore:
            directory = self.directory(task_id)
            status = read_status(directory)
            workspace = directory / "derived" / version
            try:
                status.update(decimate_status="running", decimate_phase="转换输入", decimate_progress=None,
                              decimate_error=None)
                write_status(directory, status)
                source = await asyncio.to_thread(self.source_for_level, directory, status, level, workspace)
                source_count = read_layout(source).count
                if target_count >= source_count:
                    raise ValueError("抽稀目标数量必须小于原层级")
                retain_percent = status.get("decimate_retain_percent")
                if retain_percent is not None and target_count != math.floor(source_count * retain_percent / 100 + 0.5):
                    raise ValueError("抽稀比例与目标高斯数不一致")
                destination = workspace / "work-lod.ply"
                hints = read_ply_coordinates(source)
                comments = ({"source": hints["source"]} if hints["source"] else {})
                if hints["epsg"]:
                    comments["epsg"] = hints["epsg"]
                for kind in ("offset", "shift", "scale"):
                    comments.update({f"{kind}{axis}": value for axis, value in zip("xyz", hints[kind])
                                     if value is not None})
                raw_destination = workspace / "work-lod-raw.ply" if comments else destination
                workspace.mkdir(parents=True, exist_ok=True)
                status.update(decimate_phase="抽稀并写出")
                write_status(directory, status)
                command = [*self.converter, str(source), "--decimate", str(target_count), str(raw_destination)]
                result = await asyncio.to_thread(subprocess.run, command, capture_output=True, text=True,
                                                 encoding="utf-8", errors="replace", timeout=7200, check=False)
                if result.returncode != 0 or not raw_destination.is_file():
                    raise ValueError(result.stderr.strip() or "抽稀处理失败")
                if comments:
                    status.update(decimate_phase="保留坐标头信息")
                    write_status(directory, status)
                    await asyncio.to_thread(clip_ply, raw_destination, destination, [],
                                            strip_coordinates=True, coordinate_comments=comments)
                count = read_layout(destination).count
                output_hints = read_ply_coordinates(destination)
                if any(output_hints[key] != hints[key] for key in ("source", "epsg", "offset", "shift", "scale")):
                    raise ValueError("抽稀工作层坐标头信息校验失败")
                derived = status.get("derived_lods", [])
                derived.append({"version": version, "source_level": level, "source_count": source_count,
                                "target_count": target_count, "count": count,
                                "retain_percent": retain_percent,
                                "path": destination.relative_to(directory).as_posix()})
                status.update(derived_lods=derived, decimate_status="ready", decimate_phase="完成",
                              decimate_progress=100)
                write_status(directory, status)
            except Exception as error:
                status.update(decimate_status="failed", decimate_error=str(error), decimate_progress=None)
                write_status(directory, status)

    def start_export(self, task_id: str, request: ExportRequest, source_path: str) -> None:
        job = asyncio.create_task(self._export(task_id, request, source_path))
        self.running[task_id] = job
        job.add_done_callback(lambda completed, key=task_id: self.running.pop(key, None))

    async def _export(self, task_id: str, request: ExportRequest, source_path: str) -> None:
        async with self.semaphore:
            directory = self.directory(task_id)
            status = read_status(directory)
            suffix = ".compressed.ply" if request.format == "compressed_ply" else ".sog"
            destination = directory / "exports" / request.version / f"lod-{request.level}{suffix}"
            try:
                destination.parent.mkdir(parents=True, exist_ok=True)
                status.update(export_status="running", export_phase="格式转换中", export_progress=None,
                              export_error=None)
                write_status(directory, status)

                result = await asyncio.to_thread(subprocess.run,
                    [*self.converter, str(directory / source_path), str(destination)],
                    capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=7200, check=False)
                if result.returncode or not destination.is_file():
                    raise ValueError(result.stderr.strip() or "格式转换失败")
                status.update(export_phase="成果校验中")
                write_status(directory, status)
                probe = probe_dataset(destination)
                if probe.format != request.format:
                    raise ValueError("导出格式校验失败")
                source_count = read_layout(directory / source_path).count
                output_count = await asyncio.to_thread(exported_gaussian_count, destination, request.format,
                                                       probe.entrypoint)
                if output_count != source_count:
                    raise ValueError("导出成果高斯数量与 PLY 成果不一致")
                exports = [item for item in status.get("exports", []) if not (
                    item["version"] == request.version and item["level"] == request.level
                    and item["format"] == request.format)]
                exports.append({"version": request.version, "level": request.level,
                                "format": request.format, "path": destination.relative_to(directory).as_posix(),
                                "bytes": destination.stat().st_size})
                status.update(exports=exports, export_status="ready", export_phase="完成", export_progress=100)
                write_status(directory, status)
            except Exception as error:
                status.update(export_status="failed", export_error=str(error), export_progress=None)
                write_status(directory, status)

    def start_streamed_export(self, task_id: str, version: str) -> None:
        job = asyncio.create_task(self._streamed_export(task_id, version))
        self.running[task_id] = job
        job.add_done_callback(lambda completed, key=task_id: self.running.pop(key, None))

    async def _streamed_export(self, task_id: str, version: str) -> None:
        async with self.semaphore:
            directory = self.directory(task_id)
            status = read_status(directory)
            destination = directory / "streamed-exports" / version / uuid.uuid4().hex / "lod-meta.json"
            try:
                status.update(streamed_export_status="running", streamed_export_phase="校验成果层级",
                              streamed_export_error=None)
                write_status(directory, status)
                group = next(item for item in status["versions"] if item["version"] == version)
                levels = validate_streamed_editor_levels(directory, group["levels"])
                destination.parent.mkdir(parents=True, exist_ok=True)
                command = [*self.converter, "--gpu", "cpu"]
                for index, level in enumerate(levels):
                    command.extend([str(directory / level["path"]), "--tag-lod", str(index)])
                command.append(str(destination))
                status.update(streamed_export_phase="构建流式分块")
                write_status(directory, status)
                result = await asyncio.to_thread(subprocess.run, command, capture_output=True, text=True,
                                                 encoding="utf-8", errors="replace", timeout=7200, check=False)
                if result.returncode:
                    raise ValueError(result.stderr.strip() or result.stdout.strip() or "流式生成失败")
                status.update(streamed_export_phase="校验流式目录")
                write_status(directory, status)
                validate_streamed_sog_directory(destination)
                counts = await asyncio.to_thread(read_streamed_sog_level_counts, destination)
                if counts != tuple(item["count"] for item in levels):
                    raise ValueError("流式成果各层高斯数量与 PLY 成果不一致")
                exports = [item for item in status.get("streamed_exports", []) if item["version"] != version]
                exports.append({"version": version, "path": destination.relative_to(directory).as_posix(),
                                "levels": [item["level"] for item in levels]})
                status.update(streamed_exports=exports, streamed_export_status="ready",
                              streamed_export_phase="完成", streamed_export_progress=100)
                write_status(directory, status)
            except Exception as error:
                status.update(streamed_export_status="failed", streamed_export_error=str(error),
                              streamed_export_progress=None)
                write_status(directory, status)


def create_editor_router(tasks: EditorTasks) -> APIRouter:
    router = APIRouter(prefix="/api/v2/gaussian-editor-tasks")

    @router.post("", status_code=202)
    async def create_task(input_kind: Annotated[str, Form()], workspace_id: Annotated[str, Form()],
                          file: Annotated[UploadFile | None, File()] = None,
                          files: Annotated[list[UploadFile] | None, File()] = None,
                          coordinate_manifest: Annotated[UploadFile | None, File()] = None):
        if input_kind not in {"single", "dataset", "lod_group"}:
            raise HTTPException(status_code=400, detail="Unsupported editor input kind")
        if input_kind == "lod_group":
            if file is not None or not files or len(files) < 2:
                raise HTTPException(status_code=400, detail="LOD group requires ordered files")
        elif input_kind == "single" and (file is None or files):
            raise HTTPException(status_code=400, detail="Single input requires one file")
        elif input_kind == "dataset" and (file is not None and Path(file.filename or "").suffix.lower() != ".zip"
                                           or file is None and not files):
            raise HTTPException(status_code=400, detail="Dataset requires ZIP or directory")
        manifest_bytes = None
        manifest = None
        if coordinate_manifest is not None:
            if input_kind != "single" or Path(coordinate_manifest.filename or "").suffix.lower() != ".json":
                raise HTTPException(status_code=400, detail="坐标说明仅支持单个压缩高斯文件和 JSON 文件")
            manifest_bytes = await coordinate_manifest.read(65537)
            if len(manifest_bytes) > 65536:
                raise HTTPException(status_code=400, detail="坐标说明文件不能超过 64 KiB")
            try:
                manifest = json.loads(manifest_bytes)
                if not isinstance(manifest, dict):
                    raise ValueError
            except (UnicodeError, ValueError) as error:
                raise HTTPException(status_code=400, detail="坐标说明不是有效的 JSON 对象") from error
        workspace = parse_workspace_id(workspace_id)
        task_id = str(uuid.uuid4())
        directory = tasks.directory(task_id)
        input_dir = directory / "input"
        input_dir.mkdir(parents=True)
        now = time.time()
        initial_state = EditState().model_dump()
        status: dict[str, Any] = {"task_id": task_id, "workspace_id": workspace,
                                  "owner_id": current_principal().key_id,
                                  "resource_token": secrets.token_urlsafe(32), "input_kind": input_kind,
                                  "status": "queued", "created_at_unix": now,
                                  "source_available": True, "source_expires_at_unix": now + tasks.retention_hours * 3600,
                                  "history": [{"label": "导入模型", "state": initial_state, "at": now}],
                                  "history_cursor": 0, "versions": [], "process_status": "not_requested",
                                  "decimate_status": "not_requested", "export_status": "not_requested",
                                  "streamed_export_status": "not_requested", "exports": [], "streamed_exports": []}
        try:
            if input_kind == "lod_group":
                lods = []
                seen = set()
                for level, upload in enumerate(files or []):
                    suffix = Path(upload.filename or "").suffix.lower()
                    if suffix != ".ply":
                        raise HTTPException(status_code=400, detail="LOD group currently requires Gaussian PLY files")
                    path = input_dir / f"lod-{level}.ply"
                    size, digest = await save_upload_with_sha256(upload, path)
                    probe = probe_dataset(path)
                    if not size or digest in seen or probe.format not in {"gaussian_ply", "compressed_ply"}:
                        raise HTTPException(status_code=400, detail="LOD files must be non-empty distinct Gaussian PLYs")
                    seen.add(digest)
                    lods.append({"level": level, "name": Path(upload.filename or "").name,
                                 "path": path.relative_to(directory).as_posix(), "bytes": size,
                                 "sha256": digest, "format": probe.format,
                                 "count": _ply_vertex_count(path)})
                status.update(lods=lods, format="lod_group", filename=lods[0]["name"])
            else:
                suffix = Path(file.filename or "").suffix.lower() if file else ".zip"
                if suffix not in {".ply", ".sog", ".spz", ".zip"}:
                    raise HTTPException(status_code=400, detail="Unsupported Gaussian file extension")
                path = input_dir / f"source{suffix}"
                size, digest = (await save_upload_with_sha256(file, path) if file else
                                await save_upload_directory_with_sha256(files or [], path))
                probe = probe_dataset(path)
                if not size or probe.format not in GAUSSIAN_FORMATS:
                    raise HTTPException(status_code=400, detail="Only supported Gaussian datasets can be edited")
                status.update(source_path=path.relative_to(directory).as_posix(), source_bytes=size,
                              source_sha256=digest, format=probe.format,
                              filename=Path(file.filename or "dataset").name if file else "数据集目录")
                if manifest is not None:
                    if probe.format not in {"compressed_ply", "sog"}:
                        raise HTTPException(status_code=422, detail="坐标说明仅可随 Compressed PLY 或 SOG 导入")
                    try:
                        count = exported_gaussian_count(path, probe.format, probe.entrypoint)
                        initial_state["geography"] = geography_from_result_manifest(
                            manifest, digest, probe.format, count, size)
                    except ValueError as error:
                        raise HTTPException(status_code=422, detail=str(error)) from error
                    manifest_path = input_dir / "coordinate-manifest.json"
                    manifest_path.write_bytes(manifest_bytes)
                    status["coordinate_manifest_path"] = manifest_path.relative_to(directory).as_posix()
                    status["history"][0].update(label="导入模型及坐标说明", state=initial_state)
            write_status(directory, status)
        except (DatasetFormatError, HTTPException) as error:
            status.update(status="failed", error=str(error.detail) if isinstance(error, HTTPException) else str(error))
            write_status(directory, status)
            if isinstance(error, HTTPException):
                raise
            raise HTTPException(status_code=400, detail=str(error)) from error
        tasks.start(task_id, "prepare")
        return tasks.present(status)

    @router.get("")
    def list_tasks(workspace_id: str):
        workspace = parse_workspace_id(workspace_id)
        if not tasks.root.is_dir():
            return []
        result = []
        for directory in tasks.root.iterdir():
            if not directory.is_dir():
                continue
            try:
                _, status = tasks.read(directory.name)
                if status.get("workspace_id") == workspace:
                    result.append(tasks.present(status))
            except (HTTPException, OSError, ValueError, KeyError, json.JSONDecodeError):
                continue
        return sorted(result, key=lambda item: item["created_at_unix"], reverse=True)

    @router.get("/{task_id}")
    def get_task(task_id: str):
        _, status = tasks.read(task_id)
        return tasks.present(status)

    @router.post("/{task_id}/edits")
    def record_edit(task_id: str, change: EditChange):
        try:
            validate_rules(change.state.rules)
            validate_transform(change.state.transform)
            if len(set(change.state.transform.scale)) != 1:
                raise ValueError("整体模型缩放目前只支持等比缩放")
            if change.state.display_clip is not None:
                clip = change.state.display_clip
                if (set(clip.planes) != {"xoy", "xoz", "yoz"}
                        or not all(math.isfinite(value) for value in (*clip.min, *clip.max, *clip.center, *clip.size))
                        or any(clip.min[index] > clip.max[index] for index in range(3))
                        or any(value <= 0 for value in clip.size)):
                    raise ValueError("显示剖切范围或矩形框尺寸无效")
            if change.state.geography is not None:
                frame = change.state.geography
                GeographicQuery(point=tuple(frame["reference"]), axes=tuple(frame["axes"]),
                                reference=tuple(frame["reference"]), independent_origin=(0, 0, 0),
                                projected_origin=tuple(frame["projected_origin"]),
                                metres_per_unit=frame["metres_per_unit"], source_epsg=frame["source_epsg"])
        except (ValueError, KeyError, TypeError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        directory, status = tasks.read(task_id)
        if status.get("process_status") in {"queued", "running"} or task_id in tasks.running:
            raise HTTPException(status_code=409, detail="Processing uses the current rule version")
        if any(level not in tasks.levels(status, directory) for level in change.state.selected_lods):
            raise HTTPException(status_code=422, detail="Selected LOD does not exist")
        selection = change.state.decimation
        if selection is not None:
            versions = {(item["version"], item["source_level"], item["target_count"],
                         item.get("retain_percent"))
                        for item in status.get("derived_lods", [])}
            pending = (status.get("decimate_version"), status.get("decimate_level"),
                       status.get("decimate_target_count"), status.get("decimate_retain_percent"))
            if (selection.version, selection.level, selection.target_count,
                    selection.retain_percent) not in versions | {pending}:
                raise HTTPException(status_code=422, detail="Selected decimation version does not exist")
        cursor = status["history_cursor"]
        history = status["history"][:cursor + 1]
        history.append({"label": change.label, "state": change.state.model_dump(), "at": time.time()})
        status.update(history=history, history_cursor=len(history) - 1)
        write_status(directory, status)
        return tasks.present(status)

    @router.post("/{task_id}/history/{index}")
    def jump_history(task_id: str, index: int):
        directory, status = tasks.read(task_id)
        if status.get("process_status") in {"queued", "running"} or task_id in tasks.running:
            raise HTTPException(status_code=409, detail="Processing uses the current rule version")
        if index < 0 or index >= len(status["history"]):
            raise HTTPException(status_code=422, detail="History step does not exist")
        status["history_cursor"] = index
        write_status(directory, status)
        return tasks.present(status)

    @router.post("/{task_id}/coordinate-query")
    def coordinate_query(task_id: str, request: GeographicQuery):
        tasks.read(task_id)
        try:
            return query_coordinates(request)
        except Exception as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @router.post("/{task_id}/coordinate-origin")
    def coordinate_origin(task_id: str, request: GeographicOrigin):
        tasks.read(task_id)
        try:
            return project_origin(request)
        except Exception as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @router.post("/{task_id}/process", status_code=202)
    async def process(task_id: str, request: ProcessRequest):
        directory, status = tasks.read(task_id)
        if status.get("status") != "ready" or task_id in tasks.running:
            raise HTTPException(status_code=409, detail="Editor task is not ready")
        levels = sorted(set(request.levels))
        if any(level not in tasks.levels(status, directory) for level in levels):
            raise HTTPException(status_code=422, detail="Selected LOD does not exist")
        state = status["history"][status["history_cursor"]]["state"]
        if status["input_kind"] == "lod_group" and len(levels) > 1:
            sources = {item["level"]: directory / item["path"] for item in status["lods"]}
            frames = [lod_coordinate_frame(read_ply_coordinates(sources[level])) for level in levels]
            if any(lod_frames_conflict(frame, other) for index, frame in enumerate(frames)
                   for other in frames[index + 1:]):
                raise HTTPException(status_code=422, detail="所选 LOD 的 EPSG、投影原点、shift 或 scale 不一致，不能批量应用规则")
            if not all(lod_frame_complete(frame) for frame in frames) and not state.get("same_local_frame_confirmed", False):
                raise HTTPException(status_code=422, detail="所选 LOD 坐标头不完整，请先确认各层使用同一局部坐标框架")
        validate_rules(state["rules"])
        version = str(uuid.uuid4())
        status.update(process_status="queued", process_phase="等待处理", process_progress=None, process_level=None,
                      process_started_at_unix=time.time(), process_version=version, process_completed=0,
                      process_total=len(levels), process_results=[], process_error=None)
        write_status(directory, status)
        tasks.start_process(task_id, levels, state, version)
        return tasks.present(status)

    @router.post("/{task_id}/decimate", status_code=202)
    async def decimate(task_id: str, request: DecimateRequest):
        directory, status = tasks.read(task_id)
        if status.get("status") != "ready" or task_id in tasks.running:
            raise HTTPException(status_code=409, detail="Editor task is not ready")
        if request.level not in tasks.levels(status, directory):
            raise HTTPException(status_code=422, detail="Selected LOD does not exist")
        version = str(uuid.uuid4())
        cursor = status["history_cursor"]
        state = {**status["history"][cursor]["state"],
                 "decimation": {"version": version, "level": request.level,
                                "target_count": request.target_count,
                                "retain_percent": request.retain_percent}}
        history = status["history"][:cursor + 1]
        detail = (f"保留 {request.retain_percent:g}%（{request.target_count:,} 高斯）"
                  if request.retain_percent is not None else f"至 {request.target_count:,} 高斯")
        history.append({"label": f"提交抽稀 LOD {request.level} {detail}",
                        "state": state, "at": time.time()})
        status.update(history=history, history_cursor=len(history) - 1)
        status.update(decimate_status="queued", decimate_phase="等待抽稀", decimate_progress=None,
                      decimate_started_at_unix=time.time(), decimate_version=version, decimate_level=request.level,
                      decimate_target_count=request.target_count,
                      decimate_retain_percent=request.retain_percent, decimate_error=None)
        write_status(directory, status)
        tasks.start_decimate(task_id, request.level, request.target_count, version)
        return tasks.present(status)

    @router.post("/{task_id}/exports", status_code=202)
    async def export(task_id: str, request: ExportRequest):
        directory, status = tasks.read(task_id)
        if status.get("status") != "ready" or task_id in tasks.running:
            raise HTTPException(status_code=409, detail="Editor task is not ready")
        entry = next((item for group in status.get("versions", []) if group["version"] == request.version
                      for item in group["levels"] if item["level"] == request.level), None)
        if not entry:
            raise HTTPException(status_code=404, detail="Editor result is unavailable")
        status.update(export_status="queued", export_phase="等待格式转换", export_progress=None,
                      export_started_at_unix=time.time(), export_error=None, export_request=request.model_dump())
        write_status(directory, status)
        tasks.start_export(task_id, request, entry["path"])
        return tasks.present(status)

    @router.get("/{task_id}/exports/{version}/{level}/{format_name}")
    def download_export(task_id: str, version: str, level: int, format_name: str):
        directory, status = tasks.read(task_id)
        entry = next((item for item in status.get("exports", []) if item["version"] == version
                      and item["level"] == level and item["format"] == format_name), None)
        if not entry:
            raise HTTPException(status_code=404, detail="Editor export is unavailable")
        path = directory / entry["path"]
        if not path.is_file():
            raise HTTPException(status_code=404, detail="Editor export is missing")
        suffix = ".compressed.ply" if format_name == "compressed_ply" else ".sog"
        return FileResponse(path, media_type="application/octet-stream", headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(f'lod-{level}-edited{suffix}')}"})

    @router.post("/{task_id}/streamed-exports", status_code=202)
    async def export_streamed(task_id: str, request: StreamedExportRequest):
        directory, status = tasks.read(task_id)
        if status.get("status") != "ready" or task_id in tasks.running:
            raise HTTPException(status_code=409, detail="Editor task is not ready")
        if not any(item["version"] == request.version for item in status.get("versions", [])):
            raise HTTPException(status_code=404, detail="Editor result is unavailable")
        status.update(streamed_export_status="queued", streamed_export_phase="等待流式生成",
                      streamed_export_progress=None, streamed_export_started_at_unix=time.time(),
                      streamed_export_error=None, streamed_export_version=request.version)
        write_status(directory, status)
        tasks.start_streamed_export(task_id, request.version)
        return tasks.present(status)

    @router.get("/{task_id}/streamed-exports/{version}")
    def download_streamed(task_id: str, version: str):
        directory, status = tasks.read(task_id)
        entry = next((item for item in status.get("streamed_exports", []) if item["version"] == version), None)
        if not entry:
            raise HTTPException(status_code=404, detail="Streamed result is unavailable")
        path = directory / entry["path"]
        if not path.is_file():
            raise HTTPException(status_code=404, detail="Streamed result is missing")
        count, size = directory_zip_metadata(path.parent)

        def protected_zip():
            with tasks.reading(task_id):
                yield from stream_directory_zip(path.parent)

        return StreamingResponse(protected_zip(), media_type="application/zip", headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(f'gaussian-editor-{version}-streamed-sog.zip')}",
            "X-Cache-File-Count": str(count), "X-Cache-Source-Bytes": str(size)})

    @router.get("/{task_id}/preview")
    def preview(task_id: str):
        directory, status = tasks.read(task_id)
        path = directory / "preview" / "model-points.bin"
        if status.get("status") != "ready" or not path.is_file():
            raise HTTPException(status_code=404, detail="Preview is unavailable")
        return FileResponse(path, media_type="application/octet-stream")

    @router.get("/{task_id}/download/{version}/{level}")
    def download(task_id: str, version: str, level: int):
        directory, status = tasks.read(task_id)
        groups = status.get("versions", [])
        if status.get("process_version") == version:
            groups = [*groups, {"version": version, "levels": status.get("process_results", [])}]
        entry = next((item for group in groups if group["version"] == version
                      for item in group["levels"] if item["level"] == level), None)
        if not entry:
            raise HTTPException(status_code=404, detail="Editor result is unavailable")
        path = directory / entry["path"]
        if not path.is_file():
            raise HTTPException(status_code=404, detail="Editor result is missing")
        return FileResponse(path, media_type="application/octet-stream", headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(f'lod-{level}-edited.ply')}"})

    @router.get("/{task_id}/manifest/{version}/{level}/{format_name}")
    def result_manifest(task_id: str, version: str, level: int, format_name: str):
        directory, status = tasks.read(task_id)
        if format_name not in {"ply", "compressed_ply", "sog"}:
            raise HTTPException(status_code=422, detail="Unsupported result format")
        group = next((item for item in status.get("versions", []) if item["version"] == version), None)
        result = next((item for item in group["levels"] if item["level"] == level), None) if group else None
        if not result:
            raise HTTPException(status_code=404, detail="Editor result is unavailable")
        if format_name != "ply" and not any(item["version"] == version and item["level"] == level
                                            and item["format"] == format_name for item in status.get("exports", [])):
            raise HTTPException(status_code=404, detail="Editor export is unavailable")
        snapshot = group.get("state")
        if snapshot is None and group.get("history_cursor", -1) < len(status["history"]):
            snapshot = status["history"][group["history_cursor"]]["state"]
        coordinate_mode = result.get("coordinate_mode", "legacy")
        coordinate_note = {
            "source": "PLY 沿用处理输入的坐标注释；若头文件中没有地理信息，本成果也不提供地理定位。高程基准未自动转换。",
            "embedded": "PLY 头文件已写入编辑后的 EPSG 与投影原点；高程基准未自动转换。",
            "manifest": "坐标框架无法无损写入 PLY 简单注释，PLY 已移除旧地理注释；请随成果保留本说明。",
            "legacy": "旧版成果的坐标写出方式未核验，请核对 PLY 头文件和本说明。",
        }[coordinate_mode]
        if format_name != "ply":
            coordinate_note += " 转换格式可能不保留坐标注释，请以本说明中的坐标框架为准。"
        source_lod = (next((item for item in status.get("lods", []) if item["level"] == level), None)
                      if status["input_kind"] == "lod_group" else None)
        if status["input_kind"] == "lod_group" and source_lod is None:
            raise HTTPException(status_code=404, detail="Editor source LOD is unavailable")
        source_name = source_lod["name"] if source_lod else status["filename"]
        source_format = source_lod["format"] if source_lod else status["format"]
        source_hints = (read_model_coordinates(directory / source_lod["path"]) if source_lod
                        else tasks.present(status).get("coordinate_metadata"))
        response = {"task_id": task_id, "version": version, "source_name": source_name,
                             "source_format": source_format, "source_coordinate_hints": source_hints,
                             "level": level, "source_gaussians": result["source_count"],
                             "result_gaussians": result["count"], "result_format": format_name,
                             "edit_state": snapshot, "coordinate_mode": coordinate_mode,
                             "result_ply_coordinate_hints": read_ply_coordinates(directory / result["path"]),
                             "coordinate_note": coordinate_note}
        if format_name != "ply":
            export = next(item for item in status["exports"] if item["version"] == version
                          and item["level"] == level and item["format"] == format_name)
            export_path = directory / export["path"]
            with export_path.open("rb") as stream:
                response["result_file_sha256"] = file_digest(stream, "sha256").hexdigest()
            response["result_file_bytes"] = export_path.stat().st_size
        return JSONResponse(response,
                            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(f'lod-{level}-edited-{format_name}-manifest.json')}"})

    return router


def create_editor_resource_router(tasks: EditorTasks) -> APIRouter:
    router = APIRouter()

    @router.get("/gaussian-editor-resources/{task_id}/{token}/{resource_path:path}")
    def resource(task_id: str, token: str, resource_path: str):
        directory = tasks.directory(task_id)
        status = read_status(directory)
        if not hmac.compare_digest(token, status["resource_token"]):
            raise HTTPException(status_code=404, detail="Resource not found")
        relative = Path(resource_path.replace("\\", "/"))
        if not relative.parts or relative.parts[0] not in {"input", "datasets", "derived", "results"}:
            raise HTTPException(status_code=404, detail="Resource not found")
        root = (directory / relative.parts[0]).resolve()
        path = (directory / relative).resolve()
        if directory.resolve() not in root.parents or root not in path.parents or not path.is_file() or path.suffix.lower() not in {
            ".json", ".webp", ".ply", ".spz", ".sog", ".lcc", ".lcc2", ".bin",
        }:
            raise HTTPException(status_code=404, detail="Resource not found")
        return FileResponse(path, media_type="application/octet-stream")

    return router
