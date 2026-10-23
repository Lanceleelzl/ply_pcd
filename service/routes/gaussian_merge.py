# SPDX-License-Identifier: GPL-3.0-or-later
"""Independent Gaussian merge tasks; source PLYs remain available after encoding."""
from __future__ import annotations

import asyncio
import hmac
import json
import math
import secrets
import shutil
import struct
import subprocess
import time
import uuid
from threading import Event
from contextlib import contextmanager
from pathlib import Path
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pyproj import CRS, Transformer
from pyproj.exceptions import CRSError

from service.auth import authorize_resource, current_principal
from service.dataset_formats import DatasetFormatError, probe_dataset, validate_streamed_sog_directory
from service.dataset_preparation import _safe_extract
from service.gaussian_merge import merge_level, read_layout, rotate_point, validate_regions, model_transform, scene_vector, file_vector, registration_components, apply_registration
from service.ply_coordinates import read_ply_coordinates
from service.storage import read_status, workspace_id, write_status
from service.streaming_zip import directory_zip_metadata, stream_directory_zip
from service.uploads import save_upload_directory_with_sha256, save_upload_with_sha256


class _ProtectedMergeResponse(StreamingResponse):
    def __init__(self, *args, tasks: "MergeTasks", task_id: str, **kwargs):
        self.tasks = tasks
        self.task_id = task_id
        super().__init__(*args, **kwargs)

    async def __call__(self, scope, receive, send):
        with self.tasks.reading(self.task_id):
            await super().__call__(scope, receive, send)


class _ProtectedMergeFileResponse(FileResponse):
    def __init__(self, *args, tasks: "MergeTasks", task_id: str, **kwargs):
        self.tasks = tasks
        self.task_id = task_id
        super().__init__(*args, **kwargs)

    async def __call__(self, scope, receive, send):
        with self.tasks.reading(self.task_id):
            await super().__call__(scope, receive, send)


def validate_merged_levels(directory: Path, status: dict) -> list[dict]:
    levels = status.get("merged_lods", [])
    if not levels or [item["level"] for item in levels] != list(range(levels[0]["level"], levels[-1]["level"] + 1)):
        raise ValueError("流式生成要求已合并层级连续，且按精细到粗略排列")
    first = None
    previous_count = None
    for item in levels:
        path = directory / item["path"]
        if not path.is_file():
            raise ValueError(f"LOD {item['level']} 合并 PLY 文件缺失")
        layout = read_layout(path)
        if layout.count != item["count"] or layout.count <= 0:
            raise ValueError(f"LOD {item['level']} 合并 PLY 点数不符")
        if first and (layout.fields != first.fields or layout.epsg != first.epsg or layout.offset != first.offset):
            raise ValueError("合并 PLY 层级间属性或地理原点不一致")
        if previous_count is not None and layout.count > previous_count:
            raise ValueError("合并 PLY 点数不符合精细到粗略顺序")
        first = first or layout
        previous_count = layout.count
    return levels


def matching_completed_levels(directory: Path, status: dict) -> list[dict]:
    """Find complete LOD files produced with the current merge inputs and rules."""
    root = directory / "merged"
    if not root.is_dir():
        return []
    target = status.get("target_model", 0)
    origin = status.get("scene_origin", status["models"][target]["offset"])
    epsg = status.get("scene_epsg", status["models"][target]["epsg"])
    levels: dict[int, dict] = {}
    for batch in sorted(root.iterdir(), key=lambda path: path.stat().st_mtime, reverse=True):
        manifest_path = batch / "merge-manifest.json"
        if not batch.is_dir() or not manifest_path.is_file():
            continue
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if (manifest.get("models") != status["models"] or
                    manifest.get("regions") != status["regions"] or
                    manifest.get("axes") != status["axes"] or
                    manifest.get("target_model") != target or
                    manifest.get("scene_origin") != origin or
                    manifest.get("source_epsg") != (epsg or None)):
                continue
            for item in manifest["merged_lods"]:
                level = item["level"]
                if type(level) is not int or not 0 <= level < status["level_count"] or level in levels:
                    continue
                source = (directory / item["path"]).resolve()
                if not source.is_relative_to(root.resolve()) or not source.is_file():
                    continue
                layout = read_layout(source)
                if layout.count == item["count"] and layout.count > 0 and \
                        source.stat().st_size == layout.data_start + layout.count * layout.stride:
                    levels[level] = item
        except (OSError, ValueError, KeyError, TypeError, IndexError):
            continue
    for item in status.get("merged_lods", []):
        try:
            level = item["level"]
            if type(level) is not int or not 0 <= level < status["level_count"]:
                continue
            source = (directory / item["path"]).resolve()
            if not source.is_relative_to(root.resolve()) or not source.is_file():
                continue
            layout = read_layout(source)
            if layout.count == item["count"] and layout.count > 0 and \
                    source.stat().st_size == layout.data_start + layout.count * layout.stride:
                levels[level] = item
        except (OSError, ValueError, KeyError, TypeError, IndexError):
            continue
    return [levels[level] for level in sorted(levels)]


def restore_completed_merge(directory: Path, status: dict) -> bool:
    """Relink a complete, still matching result after a replacement run was cancelled."""
    root = directory / "merged"
    if not root.is_dir():
        return False
    target = status.get("target_model", 0)
    origin = status.get("scene_origin", status["models"][target]["offset"])
    epsg = status.get("scene_epsg", status["models"][target]["epsg"])
    batches = sorted(root.iterdir(), key=lambda path: path.stat().st_mtime, reverse=True)
    for batch in batches:
        manifest_path = batch / "merge-manifest.json"
        if not batch.is_dir() or not manifest_path.is_file():
            continue
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if (manifest.get("run_complete") is False or
                    manifest.get("models") != status["models"] or
                    manifest.get("regions") != status["regions"] or
                    manifest.get("axes") != status["axes"] or
                    manifest.get("target_model") != target or
                    manifest.get("scene_origin") != origin or
                    manifest.get("source_epsg") != (epsg or None)):
                continue
            levels = manifest["merged_lods"]
            if not levels or any(item["level"] < 0 or item["level"] >= status["level_count"] or
                    not (directory / item["path"]).resolve().is_relative_to(root.resolve()) for item in levels):
                continue
            for item in levels:
                source = directory / item["path"]
                layout = read_layout(source)
                if layout.count != item["count"] or layout.count <= 0 or \
                        source.stat().st_size != layout.data_start + layout.count * layout.stride:
                    raise ValueError("旧合并成果文件不完整")
        except (OSError, ValueError, KeyError, TypeError):
            continue
        selected = [item["level"] for item in levels]
        status.update(merge_status="ready", merge_error=None,
                      merge_path=batch.relative_to(directory).as_posix(),
                      merged_lods=levels, selected_levels=selected,
                      level_progress=[{"level": level, "status": "ready" if level in selected else "not_selected",
                                       "processed": 0, "total": 0} for level in range(status["level_count"])])
        return True
    return False


class MergeCancelled(Exception):
    pass


class MergeTasks:
    def __init__(self, runtime_root: Path, converter: list[str]) -> None:
        self.root = runtime_root / "gaussian-merge-tasks"
        self.converter = converter
        self.running: dict[str, asyncio.Task[None]] = {}
        self.cancellations: dict[str, Event] = {}
        self.readers: dict[str, int] = {}
        self.semaphore = asyncio.Semaphore(1)

    @contextmanager
    def reading(self, task_id: str):
        self.readers[task_id] = self.readers.get(task_id, 0) + 1
        try:
            yield
        finally:
            remaining = self.readers[task_id] - 1
            if remaining:
                self.readers[task_id] = remaining
            else:
                self.readers.pop(task_id)

    def directory(self, task_id: str) -> Path:
        try:
            return self.root / str(uuid.UUID(task_id))
        except ValueError as error:
            raise HTTPException(status_code=404, detail="合并任务不存在") from error

    def read(self, task_id: str) -> tuple[Path, dict]:
        directory = self.directory(task_id)
        status = read_status(directory)
        authorize_resource(status)
        return directory, status

    def start(self, task_id: str, operation: str) -> None:
        current = self.running.get(task_id)
        if current and not current.done():
            return
        if operation == "merge":
            self.cancellations[task_id] = Event()
        task = asyncio.create_task(self._run(task_id, operation))
        self.running[task_id] = task
        def finished(completed: asyncio.Task[None]) -> None:
            if self.running.get(task_id) is completed:
                self.running.pop(task_id, None)
                self.cancellations.pop(task_id, None)
        task.add_done_callback(finished)

    def cancel(self, task_id: str) -> None:
        cancellation = self.cancellations.get(task_id)
        if cancellation is not None:
            cancellation.set()

    def recover(self) -> None:
        if not self.root.is_dir():
            return
        for directory in self.root.iterdir():
            if not directory.is_dir():
                continue
            try:
                status = read_status(directory)
                task_id = status["task_id"]
                if status.get("merge_status") in {"queued", "running"}:
                    self.start(task_id, "merge")
                elif status.get("cache_status") in {"queued", "running"}:
                    relative = status.get("cache_path")
                    if relative:
                        try:
                            validate_streamed_sog_directory(directory / relative)
                        except (OSError, DatasetFormatError):
                            pass
                        else:
                            status["cache_status"] = "ready"
                            write_status(directory, status)
                            continue
                    self.start(task_id, "generate")
            except (OSError, ValueError, KeyError, HTTPException):
                continue

    async def _run(self, task_id: str, operation: str) -> None:
        directory = self.directory(task_id)
        async with self.semaphore:
            status = read_status(directory)
            key = "merge_status" if operation == "merge" else "cache_status"
            try:
                if operation == "merge" and self.cancellations[task_id].is_set():
                    raise MergeCancelled()
                status[key] = "running"
                write_status(directory, status)
                if operation == "merge":
                    result = await asyncio.to_thread(self._merge, directory, status)
                    if self.cancellations[task_id].is_set():
                        raise MergeCancelled()
                    status = read_status(directory)
                    status.update(merge_status="ready", merged_lods=result, merge_error=None)
                else:
                    relative = await asyncio.to_thread(self._encode, directory, status)
                    status = read_status(directory)
                    status.update(cache_status="ready", cache_path=relative, cache_error=None)
                write_status(directory, status)
            except MergeCancelled:
                status = read_status(directory)
                status.update(merge_status="cancelled", merge_error="合并已终止")
                for item in status.get("level_progress", []):
                    if item["status"] in {"queued", "running"}:
                        item["status"] = "cancelled"
                restore_completed_merge(directory, status)
                write_status(directory, status)
            except Exception as error:
                status = read_status(directory)
                status[key] = "failed"
                status["merge_error" if operation == "merge" else "cache_error"] = str(error)
                if operation == "merge":
                    for item in status.get("level_progress", []):
                        if item["status"] == "running":
                            item.update(status="failed", error=str(error))
                write_status(directory, status)

    def _merge(self, directory: Path, status: dict) -> list[dict]:
        cancellation = self.cancellations.get(status["task_id"])
        selected = status.get("selected_levels", list(range(status["level_count"])))
        status.setdefault("level_progress", [{"level": level, "status": "queued", "processed": 0, "total": 0}
                                             for level in range(status["level_count"])])
        required = sum(model["lods"][level]["bytes"] for model in status["models"] for level in selected
                       if status["level_progress"][level]["status"] != "ready")
        if shutil.disk_usage(directory).free < required:
            raise ValueError("可用磁盘空间不足以写入合并 PLY 文件组")
        result = list(status.get("merged_lods", []))
        root = directory / status.get("merge_path", "merged")
        root.mkdir(parents=True, exist_ok=True)
        target_model = status.get("target_model", 0)
        geography = {"epsg": status.get("scene_epsg", status["models"][target_model]["epsg"]),
                     "offset": status.get("scene_origin", status["models"][target_model]["offset"])}

        def write_manifest(run_complete: bool) -> None:
            manifest = {"schema_version": 1, "run_complete": run_complete,
                        "coordinate_mode": "projected" if geography["offset"] is not None else "relative_local",
                        "source_epsg": geography["epsg"] or None, "scene_origin": geography["offset"],
                        "target_model": target_model, "axes": status["axes"],
                        "models": status["models"], "regions": status["regions"], "merged_lods": result}
            temporary = root / f"merge-manifest.{uuid.uuid4().hex}.tmp"
            temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
            temporary.replace(root / "merge-manifest.json")

        for level in selected:
            if cancellation is not None and cancellation.is_set():
                raise MergeCancelled()
            inputs = [directory / model["lods"][level]["path"] for model in status["models"]]
            completed = next((item for item in status.get("merged_lods", []) if item["level"] == level), None)
            output = root / f"lod-{level}.ply"
            existing = directory / completed["path"] if completed else output
            if status["level_progress"][level]["status"] == "ready" and existing.is_file():
                layout = read_layout(existing)
                if layout.count > 0 and existing.stat().st_size == layout.data_start + layout.count * layout.stride and \
                        (completed is None or layout.count == completed["count"]):
                    if completed is None:
                        completed = {"level": level, "path": existing.relative_to(directory).as_posix(),
                                     "count": layout.count, "by_model": [], "bounds": None,
                                     "epsg": layout.epsg, "offset": layout.offset}
                        status.setdefault("merged_lods", []).append(completed)
                        status["merged_lods"].sort(key=lambda item: item["level"])
                        result.append(completed)
                        write_status(directory, status)
                    continue
            status["level_progress"][level].update(status="running", processed=0)
            write_status(directory, status)
            def update_progress(processed: int, total: int) -> None:
                if cancellation is not None and cancellation.is_set():
                    raise MergeCancelled()
                status["level_progress"][level].update(processed=processed, total=total)
                write_status(directory, status)
            summary = merge_level(inputs, output, status["regions"],
                                  [tuple(model["correction"]) for model in status["models"]],
                                  tuple(status["axes"]), target_model, status["models"], geography,
                                  update_progress,
                                  [tuple(model.get("rotation", [1, 0, 0, 0])) for model in status["models"]],
                                  [model.get("registration_matrix") for model in status["models"]])
            completed = {"level": level, "path": output.relative_to(directory).as_posix(), **summary}
            result = [item for item in result if item["level"] != level] + [completed]
            result.sort(key=lambda item: item["level"])
            status["merged_lods"] = [item for item in status.get("merged_lods", []) if item["level"] != level] + [completed]
            status["merged_lods"].sort(key=lambda item: item["level"])
            status["level_progress"][level].update(status="ready", processed=status["level_progress"][level]["total"])
            write_manifest(False)
            write_status(directory, status)
        write_manifest(True)
        return result

    def _encode(self, directory: Path, status: dict) -> str:
        destination = directory / "streamed" / uuid.uuid4().hex / "lod-meta.json"
        levels = validate_merged_levels(directory, status)
        destination.parent.mkdir(parents=True, exist_ok=True)
        command = [*self.converter, "--gpu", "cpu"]
        for index, level in enumerate(levels):
            command.extend([str(directory / level["path"]), "--tag-lod", str(index)])
        command.append(str(destination))
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8",
                                errors="replace", timeout=7200, check=False)
        if result.returncode:
            raise DatasetFormatError(result.stderr.strip() or result.stdout.strip() or "流式生成失败")
        validate_streamed_sog_directory(destination)
        return destination.relative_to(directory).as_posix()


def create_merge_router(tasks: MergeTasks) -> APIRouter:
    router = APIRouter(prefix="/api/v2/gaussian-merges")

    @router.get("/coordinate-preview")
    def coordinate_preview(epsg: int, x: float, y: float, z: float) -> dict:
        try:
            crs = CRS.from_epsg(epsg)
            if not crs.is_projected or not all(math.isfinite(value) for value in (x, y, z)):
                raise ValueError("模型原点坐标无效")
            lon, lat = Transformer.from_crs(crs, 4326, always_xy=True).transform(x, y)
            if not all(math.isfinite(value) for value in (lon, lat)) or not -180 <= lon <= 180 or not -90 <= lat <= 90:
                raise ValueError("投影坐标无法转换为有效经纬度")
            return {"wgs84": [lon, lat, z]}
        except (ValueError, CRSError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @router.post("/coordinates/convert")
    def convert_coordinates(payload: dict) -> dict:
        try:
            crs = CRS.from_epsg(int(payload["epsg"]))
            mode = payload["mode"]
            points = payload["points"]
            if not crs.is_projected or mode not in {"projected", "wgs84"} or not isinstance(points, list) or len(points) > 1000:
                raise ValueError("坐标转换参数无效")
            if any(not isinstance(point, list) or len(point) != 2 or
                   any(type(value) not in (int, float) or not math.isfinite(value) for value in point)
                   for point in points):
                raise ValueError("坐标转换参数无效")
            if mode == "wgs84" and any(not -180 <= point[0] <= 180 or not -90 <= point[1] <= 90 for point in points):
                raise ValueError("经纬度超出有效范围")
            source, destination = (crs, 4326) if mode == "projected" else (4326, crs)
            transformer = Transformer.from_crs(source, destination, always_xy=True)
            converted = [list(transformer.transform(*point)) for point in points]
            if any(not all(math.isfinite(value) for value in point) for point in converted):
                raise ValueError("坐标转换结果无效")
            return {"points": converted}
        except (KeyError, ValueError, TypeError, CRSError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @router.post("", status_code=202)
    async def create_merge(workspace: Annotated[str, Form()], model_levels: Annotated[str, Form()],
                           files: Annotated[list[UploadFile], File()],
                           target_model: Annotated[int, Form()] = 0,
                           model_coordinates: Annotated[str, Form()] = "[]",
                           stream_counts: Annotated[str, Form()] = "[]",
                           stream_files: Annotated[list[UploadFile] | None, File()] = None) -> dict:
        workspace = workspace_id(workspace)
        try:
            levels = json.loads(model_levels)
            if not isinstance(levels, list) or len(levels) < 2 or len(levels) > 8 or \
                    any(not isinstance(count, int) or count < 1 or count > 32 for count in levels) or \
                    sum(levels) != len(files) or len(set(levels)) != 1:
                raise ValueError("每个模型需提供相同数量、已确认对应的 LOD PLY")
            if not 0 <= target_model < len(levels):
                raise ValueError("目标模型无效")
        except (ValueError, TypeError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        try:
            coordinate_inputs = json.loads(model_coordinates)
            if coordinate_inputs != [] and (not isinstance(coordinate_inputs, list) or
                                            len(coordinate_inputs) != len(levels)):
                raise ValueError("模型坐标输入数量不匹配")
        except (ValueError, TypeError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        try:
            stream_sizes = json.loads(stream_counts)
            if stream_sizes == []:
                stream_sizes = [0] * len(levels)
            if not isinstance(stream_sizes, list) or len(stream_sizes) != len(levels) or \
                    any(not isinstance(value, int) or value < 0 for value in stream_sizes) or \
                    sum(stream_sizes) != len(stream_files or []):
                raise ValueError("流式数据文件分组不匹配")
        except (ValueError, TypeError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        task_id = str(uuid.uuid4())
        directory = tasks.directory(task_id)
        directory.mkdir(parents=True)
        status = {"task_id": task_id, "workspace_id": workspace,
                  "owner_id": current_principal().key_id, "resource_token": secrets.token_urlsafe(32),
                  "created_at_unix": time.time(), "level_count": levels[0], "models": [],
                  "regions": [], "axes": [1, 2, 3], "units_confirmed": False, "target_model": target_model,
                  "merge_status": "editing", "cache_status": "not_requested"}
        index = 0
        try:
            for model_number, count in enumerate(levels):
                lods = []
                for level in range(count):
                    upload = files[index]
                    index += 1
                    if Path(upload.filename or "").suffix.lower() != ".ply":
                        raise ValueError("仅接收 Gaussian PLY 层级文件")
                    path = directory / "input" / f"model-{model_number}" / f"lod-{level}.ply"
                    path.parent.mkdir(parents=True, exist_ok=True)
                    size, digest = await save_upload_with_sha256(upload, path)
                    layout = read_layout(path)
                    if size == 0 or layout.count == 0:
                        raise ValueError("LOD PLY 为空")
                    lods.append({"level": level, "name": Path(upload.filename or "").name,
                                 "path": path.relative_to(directory).as_posix(), "bytes": size,
                                 "sha256": digest, "count": layout.count})
                header_geo = read_ply_coordinates(directory / lods[0]["path"])
                supplied = coordinate_inputs[model_number] if coordinate_inputs else None
                if supplied is not None and not isinstance(supplied, dict):
                    raise ValueError("模型坐标输入无效")
                confirmed = supplied.get("confirmed") if supplied is not None else bool(
                    header_geo["epsg"] and all(value is not None for value in header_geo["offset"]))
                epsg = supplied.get("epsg") if supplied is not None else header_geo["epsg"]
                offset = supplied.get("offset") if supplied is not None else header_geo["offset"]
                if not isinstance(confirmed, bool) or not isinstance(epsg, str) or \
                        not isinstance(offset, list) or len(offset) != 3:
                    raise ValueError("模型坐标输入无效")
                if confirmed:
                    try:
                        resolved_offset = [float(value) if value is not None and str(value).strip() else math.nan
                                           for value in offset]
                    except (TypeError, ValueError) as error:
                        raise ValueError("已确认模型的 offset 无效") from error
                    if not epsg.isdecimal() or not 0 < int(epsg) < 1000000 or any(
                            not math.isfinite(value) for value in resolved_offset):
                        raise ValueError("已确认模型必须填写有效 EPSG 和完整 offset")
                else:
                    resolved_offset = None
                    epsg = ""
                status["models"].append({"lods": lods, "epsg": epsg,
                                         "offset": resolved_offset, "source": header_geo["source"],
                                         "correction": [0, 0, 0], "rotation": [1, 0, 0, 0],
                                         "axes": [1, 2, 3], "unit": "m", "scale": 1.0,
                                         "confirmed": False})
            stream_index = 0
            for model_number, count in enumerate(stream_sizes):
                if not count:
                    continue
                uploads = (stream_files or [])[stream_index:stream_index + count]
                stream_index += count
                path = directory / "input" / f"stream-{model_number}.zip"
                if count == 1 and Path(uploads[0].filename or "").suffix.lower() == ".zip":
                    await save_upload_with_sha256(uploads[0], path)
                else:
                    await save_upload_directory_with_sha256(uploads, path)
                probe = probe_dataset(path)
                if probe.format != "streamed_sog":
                    raise ValueError("可选预览数据必须是完整 Streamed SOG 目录或 ZIP")
                status["models"][model_number]["stream_path"] = path.relative_to(directory).as_posix()
                status["models"][model_number]["stream_entrypoint"] = probe.entrypoint
            for level in range(levels[0]):
                layouts = [read_layout(directory / model["lods"][level]["path"])
                           for model in status["models"]]
                if any(item.fields != layouts[0].fields for item in layouts):
                    raise ValueError("对应 LOD 的 Gaussian 属性结构不一致")
            known = {model["epsg"] for model in status["models"] if model["offset"] is not None}
            if len(known) > 1:
                raise ValueError("已确认模型的 EPSG 不一致")
            if known and not CRS.from_epsg(int(next(iter(known)))).is_projected:
                raise ValueError("已确认 EPSG 必须是投影坐标系")
            write_status(directory, status)
            return status
        except (OSError, ValueError, DatasetFormatError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @router.get("")
    def list_merges(workspace: str) -> list[dict]:
        target = workspace_id(workspace)
        result = []
        if tasks.root.is_dir():
            for directory in tasks.root.iterdir():
                try:
                    status = read_status(directory)
                    authorize_resource(status)
                    if status["workspace_id"] == target:
                        result.append(status)
                except (OSError, ValueError, HTTPException):
                    continue
        return sorted(result, key=lambda item: item["created_at_unix"], reverse=True)

    @router.get("/{task_id}")
    def get_merge(task_id: str) -> dict:
        directory, status = tasks.read(task_id)
        completed = {item["level"]: item for item in matching_completed_levels(directory, status)}
        progress = {item["level"]: dict(item) for item in status.get("level_progress", [])}
        for level in range(status["level_count"]):
            item = progress.setdefault(level, {"level": level, "status": "not_selected", "processed": 0, "total": 0})
            if level in completed and item["status"] == "not_selected":
                item["status"] = "ready"
        cache_url = (f"/merge-resources/{task_id}/{status['resource_token']}/{status['cache_path']}"
                     if status.get("cache_status") == "ready" and status.get("cache_path") else None)
        return {**status, "merged_lods": [completed[level] for level in sorted(completed)],
                "level_progress": [progress[level] for level in range(status["level_count"])],
                "partial_lod_downloads": True, "cache_url": cache_url}

    @router.get("/{task_id}/origin")
    def get_origin(task_id: str) -> dict:
        _, status = tasks.read(task_id)
        target = status["models"][status.get("target_model", 0)]
        epsg = status.get("scene_epsg", target["epsg"])
        projected = status.get("scene_origin", target["offset"])
        geographic = None
        if epsg and projected is not None:
            lon, lat = Transformer.from_crs(CRS.from_epsg(int(epsg)), 4326, always_xy=True).transform(
                projected[0], projected[1])
            geographic = [lon, lat, projected[2]]
        return {"epsg": epsg, "projected": projected, "wgs84": geographic}

    @router.put("/{task_id}/origin")
    def save_origin(task_id: str, payload: dict) -> dict:
        directory, status = tasks.read(task_id)
        if status["merge_status"] in {"queued", "running"} or status["cache_status"] in {"queued", "running"}:
            raise HTTPException(status_code=409, detail="处理期间不能修改目标地理锚点")
        if task_id in tasks.readers:
            raise HTTPException(status_code=409, detail="成果下载期间不能修改目标地理锚点")
        if payload.get("mode") == "reset":
            if set(payload) != {"mode"}:
                raise HTTPException(status_code=422, detail="目标坐标输入无效")
            if "scene_epsg" not in status and "scene_origin" not in status:
                return get_origin(task_id)
            status.pop("scene_epsg", None)
            status.pop("scene_origin", None)
            status.update(merge_status="editing", merged_lods=[], level_progress=[],
                          cache_status="not_requested", cache_path=None)
            write_status(directory, status)
            return get_origin(task_id)
        epsg = payload.get("epsg")
        values = payload.get("values")
        mode = payload.get("mode")
        if not isinstance(epsg, str) or not epsg.isdecimal() or not isinstance(values, list) or len(values) != 3 or \
                any(type(value) not in (int, float) or not math.isfinite(value) for value in values) or \
                mode not in {"projected", "wgs84"}:
            raise HTTPException(status_code=422, detail="目标坐标输入无效")
        try:
            crs = CRS.from_epsg(int(epsg))
            if not crs.is_projected:
                raise ValueError("EPSG 必须是投影坐标系")
            if any(model["epsg"] and model["offset"] is not None and model["epsg"] != epsg
                   for model in status["models"]):
                raise ValueError("目标 EPSG 必须与已确认的模型投影编码一致")
            if mode == "wgs84":
                lon, lat, height = values
                if not -180 <= lon <= 180 or not -90 <= lat <= 90:
                    raise ValueError("经纬度超出有效范围")
                east, north = Transformer.from_crs(4326, crs, always_xy=True).transform(lon, lat)
                projected = [east, north, height]
            else:
                projected = values
            if not all(math.isfinite(value) for value in projected):
                raise ValueError("坐标转换结果无效")
        except (ValueError, TypeError, CRSError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        target = status["models"][status.get("target_model", 0)]
        current_epsg = status.get("scene_epsg", target["epsg"])
        current_origin = status.get("scene_origin", target["offset"])
        if current_epsg == epsg and current_origin is not None and all(
                abs(a - b) <= 0.00005 for a, b in zip(current_origin, projected)):
            return get_origin(task_id)
        status["scene_epsg"] = epsg
        status["scene_origin"] = projected
        status.update(merge_status="editing", merged_lods=[], level_progress=[],
                      cache_status="not_requested", cache_path=None)
        write_status(directory, status)
        return get_origin(task_id)

    @router.put("/{task_id}/regions")
    def save_regions(task_id: str, payload: dict) -> dict:
        directory, status = tasks.read(task_id)
        if status["merge_status"] == "running":
            raise HTTPException(status_code=409, detail="合并正在执行")
        if task_id in tasks.readers:
            raise HTTPException(status_code=409, detail="合并成果正在下载")
        if status["cache_status"] in {"queued", "running"}:
            raise HTTPException(status_code=409, detail="流式生成期间不能修改范围")
        before = json.dumps({"regions": status["regions"], "axes": status["axes"],
                            "target_model": status.get("target_model", 0),
                            "units_confirmed": status.get("units_confirmed", False), "corrections":
                            [model["correction"] for model in status["models"]], "rotations":
                            [model.get("rotation", [1, 0, 0, 0]) for model in status["models"]],
                            "registration_matrices": [model.get("registration_matrix") for model in status["models"]],
                            "model_settings": [{key: model.get(key) for key in ("axes", "unit", "scale", "confirmed")}
                                               for model in status["models"]]}, sort_keys=True)
        regions = payload.get("regions")
        corrections = payload.get("corrections")
        rotations = payload.get("rotations", [model.get("rotation", [1, 0, 0, 0]) for model in status["models"]])
        registration_matrices = payload.get("registration_matrices", [model.get("registration_matrix") for model in status["models"]])
        axes = payload.get("axes")
        units_confirmed = payload.get("units_confirmed")
        model_settings = payload.get("model_settings")
        target_model = payload.get("target_model", status.get("target_model", 0))
        try:
            if not isinstance(regions, list) or len(regions) > 200:
                raise ValueError("裁剪范围无效")
            validate_regions(regions, len(status["models"]))
            if not isinstance(axes, list) or sorted(abs(value) for value in axes if isinstance(value, int)) != [1, 2, 3]:
                raise ValueError("东北上轴向无效")
            if not isinstance(units_confirmed, bool):
                raise ValueError("请确认文件 XYZ 与投影坐标单位及高度基准")
            if model_settings is not None:
                if not isinstance(model_settings, list) or len(model_settings) != len(status["models"]):
                    raise ValueError("模型单位与轴向设置数量不匹配")
                for model, setting in zip(status["models"], model_settings):
                    if not isinstance(setting, dict) or not isinstance(setting.get("confirmed"), bool):
                        raise ValueError("请分别确认每个模型的单位、比例与上方向")
                    checked = {"axes": setting.get("axes"), "unit": setting.get("unit"),
                               "scale": setting.get("scale"), "confirmed": setting["confirmed"]}
                    model_transform(checked)
                    model.update(checked)
                units_confirmed = all(model["confirmed"] for model in status["models"])
                axes = list(model_transform(status["models"][target_model])[0])
            else:
                for model in status["models"]:
                    model.update(axes=list(axes), unit="m", scale=1.0, confirmed=units_confirmed)
            if type(target_model) is not int or not 0 <= target_model < len(status["models"]):
                raise ValueError("目标模型无效")
            if not isinstance(corrections, list) or len(corrections) != len(status["models"]):
                raise ValueError("模型校正数量不匹配")
            for model, correction in zip(status["models"], corrections):
                if not isinstance(correction, list) or len(correction) != 3 or not all(
                        isinstance(value, (int, float)) and abs(value) < 1e9 for value in correction):
                    raise ValueError("模型校正平移无效")
                model["correction"] = correction
            if not isinstance(rotations, list) or len(rotations) != len(status["models"]):
                raise ValueError("模型校正旋转数量不匹配")
            for model, rotation in zip(status["models"], rotations):
                if not isinstance(rotation, list) or len(rotation) != 4 or not all(
                        isinstance(value, (int, float)) and math.isfinite(value) for value in rotation) or \
                        abs(sum(value * value for value in rotation) - 1) > 1e-4:
                    raise ValueError("模型校正旋转无效")
                model["rotation"] = rotation
            if not isinstance(registration_matrices, list) or len(registration_matrices) != len(status["models"]):
                raise ValueError("配准矩阵数量不匹配")
            if registration_matrices[target_model] is not None:
                raise ValueError("配准矩阵只能作用于待合入模型；切换目标前请先清除矩阵")
            for index, (model, matrix) in enumerate(zip(status["models"], registration_matrices)):
                registration_components(matrix)
                if matrix is not None and model.get("offset") is not None:
                    raise ValueError("已有坐标的模型无需输入配准矩阵")
                if matrix is None:
                    model.pop("registration_matrix", None)
                else:
                    model["registration_matrix"] = matrix
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        previous_target = status.get("target_model", 0)
        if target_model != previous_target:
            status.pop("scene_origin", None)
            status.pop("scene_epsg", None)
            def projected_shift(model_index: int, reference_index: int) -> list[float]:
                model_offset = status["models"][model_index]["offset"]
                reference_offset = status["models"][reference_index]["offset"]
                if model_offset is None or reference_offset is None:
                    return [0.0, 0.0, 0.0]
                return [model_offset[axis] - reference_offset[axis] for axis in range(3)]

            old_positions = []
            for index, model in enumerate(status["models"]):
                model_axes, factor = model_transform(model, tuple(axes))
                shift = scene_vector(model["correction"], model_axes, factor)
                old_positions.append([shift[axis] + projected_shift(index, previous_target)[axis]
                                      for axis in range(3)])
            base = old_positions[target_model]
            for index, model in enumerate(status["models"]):
                corrected = [old_positions[index][axis] - base[axis] -
                             projected_shift(index, target_model)[axis] for axis in range(3)]
                model_axes, factor = model_transform(model, tuple(axes))
                model["correction"] = file_vector(corrected, model_axes, factor)
            east, north = base[:2]
            regions = [dict(region, polygon=[
                [point[0] - east, point[1] - north]
                for point in region["polygon"]]) for region in regions]
        status["regions"] = regions
        status["axes"] = axes
        status["units_confirmed"] = units_confirmed
        status["target_model"] = target_model
        after = json.dumps({"regions": status["regions"], "axes": status["axes"],
                           "target_model": status["target_model"],
                           "units_confirmed": status["units_confirmed"], "corrections":
                           [model["correction"] for model in status["models"]], "rotations":
                           [model.get("rotation", [1, 0, 0, 0]) for model in status["models"]],
                           "registration_matrices": [model.get("registration_matrix") for model in status["models"]],
                           "model_settings": [{key: model.get(key) for key in ("axes", "unit", "scale", "confirmed")}
                                              for model in status["models"]]}, sort_keys=True)
        if before != after:
            status.update(merge_status="editing", cache_status="not_requested", merged_lods=[], level_progress=[])
        if status["merge_status"] == "editing" and status.get("merge_path"):
            previous_merge_path = status["merge_path"]
            if restore_completed_merge(directory, status) and status["merge_path"] == previous_merge_path:
                cache_path = status.get("cache_path")
                if cache_path:
                    try:
                        validate_streamed_sog_directory(directory / cache_path)
                    except (OSError, DatasetFormatError):
                        pass
                    else:
                        status["cache_status"] = "ready"
        write_status(directory, status)
        return status

    def sample_preview(directory: Path, status: dict, level: int | None = None) -> dict:
        origin = status["models"][status.get("target_model", 0)]["offset"]
        axes = status["axes"]
        models = []
        for model_number, model in enumerate(status["models"]):
            model_axes, factor = model_transform(model, tuple(axes))
            registration_matrix = model.get("registration_matrix")
            source_path = directory / model["lods"][level if level is not None else -1]["path"]
            if level is None and model.get("stream_path"):
                preview_path = directory / "preview" / f"stream-{model_number}.ply"
                if not preview_path.is_file():
                    extracted = directory / "preview" / f"stream-{model_number}"
                    _safe_extract(directory / model["stream_path"], extracted)
                    entrypoint = extracted / model["stream_entrypoint"]
                    validate_streamed_sog_directory(entrypoint)
                    metadata = json.loads(entrypoint.read_text(encoding="utf-8-sig"))
                    level_count = metadata["lodLevels"]
                    preview_path.parent.mkdir(parents=True, exist_ok=True)
                    result = subprocess.run([*tasks.converter, "--select-lod", str(level_count - 1),
                                             str(entrypoint), str(preview_path)], capture_output=True,
                                            text=True, encoding="utf-8", errors="replace", timeout=3600,
                                            check=False)
                    if result.returncode:
                        raise ValueError(result.stderr.strip() or "流式预览解码失败")
                source_path = preview_path
            layout = read_layout(source_path, require_geo=False)
            xyz = [layout.field(axis) for axis in "xyz"]
            shift = scene_vector(model["correction"], model_axes, factor)
            if registration_matrix is None and model["offset"] is not None and origin is not None:
                shift = [value + model["offset"][axis] - origin[axis]
                         for axis, value in enumerate(shift)]
            count = min(layout.count, 30000)
            points = []
            with layout.path.open("rb") as source:
                for index in range(count):
                    row = index * layout.count // count
                    source.seek(layout.data_start + row * layout.stride)
                    raw = source.read(layout.stride)
                    source_point = [struct.unpack_from("<" + code, raw, position)[0]
                                    for code, position in xyz]
                    if all(math.isfinite(value) for value in source_point):
                        scene_point = rotate_point(model.get("rotation", [1, 0, 0, 0]),
                                                   apply_registration(registration_matrix,
                                                                      scene_vector(source_point, model_axes, factor)))
                        points.append([scene_point[axis] + shift[axis] for axis in range(3)])
            models.append(points)
        return {"models": models}

    @router.get("/{task_id}/preview")
    async def preview(task_id: str, level: int | None = None) -> dict:
        directory, status = tasks.read(task_id)
        if level is not None and (level < 0 or level >= len(status["models"][0]["lods"])):
            raise HTTPException(status_code=404, detail="LOD 层级不存在")
        return await asyncio.to_thread(sample_preview, directory, status, level)

    @router.get("/{task_id}/lod/{level}/{model}")
    def source_lod(task_id: str, level: int, model: int) -> FileResponse:
        directory, status = tasks.read(task_id)
        if model < 0 or model >= len(status["models"]) or level < 0 or \
                level >= len(status["models"][model]["lods"]):
            raise HTTPException(status_code=404, detail="模型或 LOD 层级不存在")
        source = directory / status["models"][model]["lods"][level]["path"]
        return _ProtectedMergeFileResponse(source, tasks=tasks, task_id=task_id,
                                           media_type="application/octet-stream")

    @router.get("/{task_id}/preview-merged/{level}")
    async def preview_merged(task_id: str, level: int) -> dict:
        directory, status = tasks.read(task_id)
        entry = next((item for item in matching_completed_levels(directory, status) if item["level"] == level), None)
        if status["merge_status"] != "ready" or entry is None:
            raise HTTPException(status_code=404, detail="合并 LOD 尚未就绪")
        layout = read_layout(directory / entry["path"])
        xyz = [layout.field(axis) for axis in "xyz"]
        axes, factor = model_transform(status["models"][status.get("target_model", 0)],
                                       tuple(status["axes"]))

        def collect() -> dict:
            count = min(layout.count, 30000)
            points = []
            with layout.path.open("rb") as source:
                for index in range(count):
                    source.seek(layout.data_start + (index * layout.count // count) * layout.stride)
                    raw = source.read(layout.stride)
                    point = [struct.unpack_from("<" + code, raw, position)[0] for code, position in xyz]
                    if all(math.isfinite(value) for value in point):
                        points.append(scene_vector(point, axes, factor))
            return {"models": [points]}

        return await asyncio.to_thread(collect)

    @router.post("/{task_id}/merge", status_code=202)
    async def start_merge(task_id: str, payload: dict | None = None) -> dict:
        directory, status = tasks.read(task_id)
        if status["merge_status"] == "running":
            return status
        if task_id in tasks.readers:
            raise HTTPException(status_code=409, detail="合并成果正在下载")
        if status["cache_status"] in {"queued", "running"}:
            raise HTTPException(status_code=409, detail="流式生成期间不能重新合并")
        if not status.get("units_confirmed"):
            raise HTTPException(status_code=422, detail="请先确认文件 XYZ 与投影坐标单位及高度基准一致")
        selected = (payload or {}).get("levels", list(range(status["level_count"])))
        if not isinstance(selected, list) or not selected or any(type(level) is not int or
                level < 0 or level >= status["level_count"] for level in selected) or len(set(selected)) != len(selected):
            raise HTTPException(status_code=422, detail="请选择有效的合并层级")
        selected.sort()
        completed = matching_completed_levels(directory, status)
        ready_levels = {item["level"] for item in completed}
        status["selected_levels"] = selected
        status["level_progress"] = [{"level": level, "status": "ready" if level in ready_levels else
                                     "queued" if level in selected else "not_selected",
                                     "processed": 0, "total": 0} for level in range(status["level_count"])]
        status["merge_path"] = f"merged/{uuid.uuid4().hex}"
        status.update(merge_status="queued", merge_error=None, merged_lods=completed,
                      cache_status="not_requested", cache_path=None)
        write_status(directory, status)
        tasks.start(task_id, "merge")
        return status

    @router.post("/{task_id}/cancel", status_code=202)
    async def cancel_merge(task_id: str) -> dict:
        directory, status = tasks.read(task_id)
        if status["merge_status"] not in {"queued", "running", "cancelling"}:
            raise HTTPException(status_code=409, detail="当前没有正在执行的合并任务")
        tasks.cancel(task_id)
        if task_id not in tasks.cancellations:
            status.update(merge_status="cancelled", merge_error="合并已终止")
            for item in status.get("level_progress", []):
                if item["status"] in {"queued", "running"}:
                    item["status"] = "cancelled"
            restore_completed_merge(directory, status)
        else:
            status["merge_status"] = "cancelling"
        write_status(directory, status)
        return status

    @router.post("/{task_id}/generate", status_code=202)
    async def generate(task_id: str) -> dict:
        directory, status = tasks.read(task_id)
        if status["merge_status"] != "ready":
            raise HTTPException(status_code=409, detail="请先完成 PLY 合并")
        completed = {item["level"]: item for item in matching_completed_levels(directory, status)}
        if len(completed) > len(status.get("merged_lods", [])):
            status["merged_lods"] = [completed[level] for level in sorted(completed)]
            for item in status.get("level_progress", []):
                if item["level"] in completed:
                    item["status"] = "ready"
            write_status(directory, status)
        try:
            validate_merged_levels(directory, status)
        except (OSError, ValueError) as error:
            raise HTTPException(status_code=422, detail=f"流式生成前校验失败：{error}") from error
        if status["cache_status"] in {"queued", "running"}:
            return status
        status.update(cache_status="queued", cache_error=None)
        write_status(directory, status)
        tasks.start(task_id, "generate")
        return status

    @router.get("/{task_id}/download/{kind}")
    def download(task_id: str, kind: str) -> StreamingResponse:
        directory, status = tasks.read(task_id)
        if kind == "ply" and status["merge_status"] == "ready":
            root = directory / status.get("merge_path", "merged")
        elif kind == "streamed" and status["cache_status"] == "ready":
            root = (directory / status["cache_path"]).parent
        else:
            raise HTTPException(status_code=404, detail="成果尚未就绪")
        count, size = directory_zip_metadata(root)
        return _ProtectedMergeResponse(stream_directory_zip(root), tasks=tasks, task_id=task_id,
                                      media_type="application/zip", headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote('gaussian-merge-' + kind + '.zip')}",
            "X-Cache-File-Count": str(count), "X-Cache-Source-Bytes": str(size),
        })

    @router.get("/{task_id}/download/ply/{level}")
    def download_merged_lod(task_id: str, level: int) -> FileResponse:
        directory, status = tasks.read(task_id)
        entry = next((item for item in matching_completed_levels(directory, status) if item["level"] == level), None)
        if entry is None:
            raise HTTPException(status_code=404, detail="合并 LOD 尚未就绪")
        source = directory / entry["path"]
        if not source.is_file():
            raise HTTPException(status_code=404, detail="合并 PLY 文件不存在")
        layout = read_layout(source)
        if layout.count <= 0 or source.stat().st_size != layout.data_start + layout.count * layout.stride or \
                (entry and layout.count != entry["count"]):
            raise HTTPException(status_code=409, detail="合并 PLY 文件不完整")
        return _ProtectedMergeFileResponse(source, tasks=tasks, task_id=task_id,
                                           media_type="application/octet-stream",
                                           filename=f"gaussian-merge-lod-{level}.ply")

    return router


def create_merge_resource_router(tasks: MergeTasks) -> APIRouter:
    router = APIRouter()

    @router.get("/merge-resources/{task_id}/{token}/{resource_path:path}")
    def merge_resource(task_id: str, token: str, resource_path: str) -> FileResponse:
        directory = tasks.directory(task_id)
        status = read_status(directory)
        if not hmac.compare_digest(token, status.get("resource_token", "")) or \
                status.get("cache_status") != "ready" or not status.get("cache_path"):
            raise HTTPException(status_code=404, detail="流式缓存不存在")
        root = (directory / status["cache_path"]).parent.resolve()
        path = (directory / resource_path.replace("\\", "/")).resolve()
        if (path != root and root not in path.parents) or not path.is_file() or \
                path.suffix.lower() not in {".json", ".webp", ".bin"}:
            raise HTTPException(status_code=404, detail="流式缓存文件不存在")
        media = {".json": "application/json", ".webp": "image/webp"}
        return _ProtectedMergeFileResponse(path, tasks=tasks, task_id=task_id,
                                           media_type=media.get(path.suffix.lower(), "application/octet-stream"))

    return router
