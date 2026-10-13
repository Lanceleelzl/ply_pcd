# SPDX-License-Identifier: GPL-3.0-or-later
"""Independent Gaussian editor tasks and non-destructive per-LOD results."""
from __future__ import annotations

import asyncio
import hmac
import json
import secrets
import subprocess
import time
import uuid
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import quote

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from service.auth import current_principal
from service.dataset_formats import DatasetFormatError, probe_dataset
from service.dataset_preparation import _convert_to_ply
from service.gaussian_editor_rules import clip_ply, validate_rules
from service.gaussian_merge import read_layout
from service.routes.streaming import StreamingTasks
from service.storage import read_status, workspace_id as parse_workspace_id, write_status
from service.streaming_tasks import GAUSSIAN_FORMATS
from service.uploads import save_upload_directory_with_sha256, save_upload_with_sha256


class EditState(BaseModel):
    rules: list[dict[str, Any]] = Field(default_factory=list)
    selected_lods: list[int] = Field(default_factory=list)


class EditChange(BaseModel):
    label: str = Field(min_length=1, max_length=100)
    state: EditState


class ProcessRequest(BaseModel):
    levels: list[int] = Field(min_length=1)


class DecimateRequest(BaseModel):
    level: int = Field(ge=0)
    target_count: int = Field(gt=0)


class EditorTasks(StreamingTasks):
    def __init__(self, runtime_root: Path, converter: list[str], worker: str, retention_hours: int) -> None:
        super().__init__(runtime_root, converter, worker, retention_hours)
        self.root = runtime_root / "gaussian-editor-tasks"

    def present(self, status: dict[str, Any]) -> dict[str, Any]:
        result = dict(status)
        task_id, token = status["task_id"], status["resource_token"]
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
            for operation in ("process", "decimate"):
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
            return source
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
                for index, level in enumerate(levels):
                    status.update(process_level=level, process_phase="转换输入", process_progress=None)
                    write_status(directory, status)
                    source = await asyncio.to_thread(self.source_for_level, directory, status, level, workspace)
                    layout = read_layout(source)
                    frame = (layout.epsg, layout.offset)
                    if reference is not None and frame != reference:
                        raise ValueError(f"LOD {level} 的 EPSG 或投影原点与其他层级不一致")
                    reference = frame
                    destination = workspace / f"lod-{level}.ply"
                    last_update = 0.0

                    def progress(done: int, total: int) -> None:
                        nonlocal last_update
                        now = time.monotonic()
                        if now - last_update < 0.3 and done < total:
                            return
                        last_update = now
                        status.update(process_phase="空间裁剪", process_progress=round(done * 100 / total, 1) if total else 100)
                        write_status(directory, status)

                    count = await asyncio.to_thread(clip_ply, source, destination, state["rules"], progress)
                    result = {"level": level, "count": count, "source_count": layout.count,
                              "path": destination.relative_to(directory).as_posix(), "bytes": destination.stat().st_size}
                    results.append(result)
                    status.update(process_phase="逐层校验", process_progress=100, process_completed=index + 1,
                                  process_results=results)
                    read_layout(destination)
                    write_status(directory, status)
                versions = status.get("versions", [])
                versions.append({"version": version, "created_at_unix": time.time(),
                                 "history_cursor": status["history_cursor"], "levels": results})
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
                destination = workspace / "work-lod.ply"
                workspace.mkdir(parents=True, exist_ok=True)
                status.update(decimate_phase="抽稀并写出")
                write_status(directory, status)
                command = [*self.converter, str(source), "--decimate", str(target_count), str(destination)]
                result = await asyncio.to_thread(subprocess.run, command, capture_output=True, text=True,
                                                 encoding="utf-8", errors="replace", timeout=7200, check=False)
                if result.returncode != 0 or not destination.is_file():
                    raise ValueError(result.stderr.strip() or "抽稀处理失败")
                count = read_layout(destination).count
                derived = status.get("derived_lods", [])
                derived.append({"version": version, "source_level": level, "source_count": source_count,
                                "target_count": target_count, "count": count,
                                "path": destination.relative_to(directory).as_posix()})
                status.update(derived_lods=derived, decimate_status="ready", decimate_phase="完成",
                              decimate_progress=100)
                write_status(directory, status)
            except Exception as error:
                status.update(decimate_status="failed", decimate_error=str(error), decimate_progress=None)
                write_status(directory, status)


def create_editor_router(tasks: EditorTasks) -> APIRouter:
    router = APIRouter(prefix="/api/v2/gaussian-editor-tasks")

    @router.post("", status_code=202)
    async def create_task(input_kind: Annotated[str, Form()], workspace_id: Annotated[str, Form()],
                          file: Annotated[UploadFile | None, File()] = None,
                          files: Annotated[list[UploadFile] | None, File()] = None):
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
                                  "decimate_status": "not_requested"}
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
                                 "sha256": digest, "format": probe.format})
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
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        directory, status = tasks.read(task_id)
        if status.get("process_status") in {"queued", "running"}:
            raise HTTPException(status_code=409, detail="Processing uses the current rule version")
        if any(level not in tasks.levels(status, directory) for level in change.state.selected_lods):
            raise HTTPException(status_code=422, detail="Selected LOD does not exist")
        cursor = status["history_cursor"]
        history = status["history"][:cursor + 1]
        history.append({"label": change.label, "state": change.state.model_dump(), "at": time.time()})
        status.update(history=history, history_cursor=len(history) - 1)
        write_status(directory, status)
        return tasks.present(status)

    @router.post("/{task_id}/history/{index}")
    def jump_history(task_id: str, index: int):
        directory, status = tasks.read(task_id)
        if status.get("process_status") in {"queued", "running"}:
            raise HTTPException(status_code=409, detail="Processing uses the current rule version")
        if index < 0 or index >= len(status["history"]):
            raise HTTPException(status_code=422, detail="History step does not exist")
        status["history_cursor"] = index
        write_status(directory, status)
        return tasks.present(status)

    @router.post("/{task_id}/process", status_code=202)
    async def process(task_id: str, request: ProcessRequest):
        directory, status = tasks.read(task_id)
        if status.get("status") != "ready" or task_id in tasks.running:
            raise HTTPException(status_code=409, detail="Editor task is not ready")
        levels = sorted(set(request.levels))
        if any(level not in tasks.levels(status, directory) for level in levels):
            raise HTTPException(status_code=422, detail="Selected LOD does not exist")
        state = status["history"][status["history_cursor"]]["state"]
        validate_rules(state["rules"])
        version = str(uuid.uuid4())
        status.update(process_status="queued", process_version=version, process_completed=0,
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
        status.update(decimate_status="queued", decimate_version=version, decimate_error=None)
        write_status(directory, status)
        tasks.start_decimate(task_id, request.level, request.target_count, version)
        return tasks.present(status)

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
