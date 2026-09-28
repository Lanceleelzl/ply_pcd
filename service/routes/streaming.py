# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import asyncio
import hmac
import json
import secrets
import shutil
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import quote

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from service.auth import authorize_resource, current_principal
from service.dataset_formats import DatasetFormatError, probe_dataset, validate_streamed_sog_directory
from service.schemas import TransformParameters
from service.storage import read_status, workspace_id as parse_workspace_id, write_status
from service.streaming_tasks import GAUSSIAN_FORMATS, generate_streaming_cache, prepare_streaming_task, preserve_streaming_cache
from service.streaming_zip import directory_zip_metadata, stream_directory_zip
from service.uploads import save_upload_directory_with_sha256, save_upload_with_sha256
from service.validation import validate_transform


class _ProtectedTaskResponse:
    def __init__(self, *args, tasks, task_id, **kwargs):
        self.tasks = tasks
        self.task_id = task_id
        super().__init__(*args, **kwargs)

    async def __call__(self, scope, receive, send):
        with self.tasks.reading(self.task_id):
            await super().__call__(scope, receive, send)


class _TaskFileResponse(_ProtectedTaskResponse, FileResponse):
    pass


class _TaskStreamingResponse(_ProtectedTaskResponse, StreamingResponse):
    pass


class StreamingTasks:
    def __init__(self, runtime_root: Path, converter: list[str], worker: str, retention_hours: int) -> None:
        self.root = runtime_root / "streaming-tasks"
        self.converter = converter
        self.worker = worker
        self.retention_hours = retention_hours
        self.semaphore = asyncio.Semaphore(1)
        self.running: dict[str, asyncio.Task[None]] = {}
        self.readers: dict[str, int] = {}

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
            parsed = uuid.UUID(task_id)
        except ValueError as error:
            raise HTTPException(status_code=404, detail="Streaming task not found") from error
        return self.root / str(parsed)

    def read(self, task_id: str) -> tuple[Path, dict[str, Any]]:
        directory = self.directory(task_id)
        status = read_status(directory)
        authorize_resource(status)
        return directory, status

    def present(self, status: dict[str, Any]) -> dict[str, Any]:
        result = dict(status)
        task_id, token = status["task_id"], status["resource_token"]
        prefix = f"/streaming-resources/{task_id}/{token}/"
        result["gaussian_url"] = prefix + status["gaussian_path"] if status.get("gaussian_path") else None
        result["cache_url"] = prefix + status["cache_path"] if status.get("cache_status") == "ready" else None
        result["lods"] = [dict(item, gaussian_url=prefix + item["path"]) for item in status.get("lods", [])]
        return result

    def start(self, task_id: str, operation: str) -> None:
        current = self.running.get(task_id)
        if current is not None and not current.done():
            if operation == "generate":
                current.add_done_callback(lambda _: self.start(task_id, "generate"))
            return
        task = asyncio.create_task(self._run(task_id, operation))
        self.running[task_id] = task
        task.add_done_callback(lambda completed, key=task_id: self.running.pop(key, None))

    async def _run(self, task_id: str, operation: str) -> None:
        async with self.semaphore:
            directory = self.directory(task_id)
            status = read_status(directory)
            try:
                if operation == "prepare":
                    status["status"] = "preparing"
                    write_status(directory, status)
                    prepared = await asyncio.to_thread(prepare_streaming_task, directory, status, self.converter, self.worker)
                    current = read_status(directory)
                    current.update({key: prepared[key] for key in (
                        "metadata", "preview_url", "gaussian_path", "gaussian_filename", "status")})
                    if prepared.get("dataset_entrypoint"):
                        current["dataset_entrypoint"] = prepared["dataset_entrypoint"]
                    write_status(directory, current)
                else:
                    status["cache_status"] = "converting"
                    status["cache_progress"] = None
                    write_status(directory, status)
                    relative = await asyncio.to_thread(generate_streaming_cache, directory, status, self.converter)
                    current = read_status(directory)
                    current.update(cache_status="ready", cache_progress=100, cache_path=relative,
                                   cache_error=None)
                    write_status(directory, current)
            except Exception as error:
                current = read_status(directory)
                if operation == "prepare":
                    current.update(status="failed", error=str(error))
                else:
                    current.update(cache_status="failed", cache_error=str(error), cache_progress=None)
                write_status(directory, current)

    def recover(self) -> None:
        if not self.root.is_dir():
            return
        for directory in self.root.iterdir():
            if not directory.is_dir():
                continue
            try:
                status = read_status(directory)
            except (OSError, ValueError, HTTPException, json.JSONDecodeError):
                continue
            if status.get("status") in {"queued", "preparing"}:
                self.start(status["task_id"], "prepare")
            elif status.get("cache_status") in {"queued", "converting"}:
                relative = status.get("cache_path") or "output/lod-meta.json"
                if isinstance(relative, str):
                    try:
                        validate_streamed_sog_directory(directory / relative)
                    except (OSError, DatasetFormatError):
                        pass
                    else:
                        status.update(cache_status="ready", cache_progress=100, cache_path=relative,
                                      cache_error=None)
                        write_status(directory, status)
                        continue
                self.start(status["task_id"], "generate")

    def release_source(self, task_id: str, directory: Path, status: dict[str, Any]) -> None:
        current = self.running.get(task_id)
        if (current is not None and not current.done()) or task_id in self.readers:
            raise HTTPException(status_code=409, detail="Streaming task is currently in use")
        relative = status.get("cache_path")
        if (status.get("cache_status") == "ready" and isinstance(relative, str)
                and relative.split("/", 1)[0] in {"input", "datasets", "computed", "preview"}):
            status["cache_path"] = preserve_streaming_cache(directory, directory / relative)
            write_status(directory, status)
        for name in ("input", "datasets", "computed", "preview"):
            shutil.rmtree(directory / name, ignore_errors=True)
        status.update(source_available=False, gaussian_path=None, preview_url=None,
                      source_expires_at_unix=None)
        write_status(directory, status)

    def cleanup_expired(self, now: float | None = None) -> None:
        if not self.root.is_dir():
            return
        current_time = time.time() if now is None else now
        for directory in self.root.iterdir():
            if not directory.is_dir():
                continue
            try:
                status = read_status(directory)
                task_id = status["task_id"]
                expires = status.get("source_expires_at_unix")
                if (not status.get("source_available", True) or expires is None
                        or float(expires) > current_time):
                    continue
                self.release_source(task_id, directory, status)
            except (HTTPException, OSError, ValueError, KeyError, json.JSONDecodeError):
                continue


def create_streaming_router(tasks: StreamingTasks) -> APIRouter:
    router = APIRouter(prefix="/api/v2/streaming-tasks")

    @router.post("", status_code=202)
    async def create_task(
        input_kind: Annotated[str, Form()],
        workspace_id: Annotated[str, Form()],
        file: Annotated[UploadFile | None, File()] = None,
        files: Annotated[list[UploadFile] | None, File()] = None,
        business_transform: Annotated[str, Form()] = "",
    ) -> dict[str, Any]:
        if input_kind not in {"single", "dataset", "lod_group"}:
            raise HTTPException(status_code=400, detail="input_kind must be single, dataset, or lod_group")
        if input_kind == "lod_group":
            if file is not None or not files or len(files) < 2:
                raise HTTPException(status_code=400, detail="LOD group requires at least two ordered files")
        elif (file is None) == (not files):
            raise HTTPException(status_code=400, detail="Provide exactly one file or one dataset directory")
        if input_kind == "single" and files:
            raise HTTPException(status_code=400, detail="Single input requires one file")
        if input_kind == "dataset" and file and Path(file.filename or "").suffix.lower() != ".zip":
            raise HTTPException(status_code=400, detail="Dataset file must be a ZIP")
        workspace = parse_workspace_id(workspace_id)
        try:
            transform = TransformParameters.model_validate_json(business_transform) if business_transform else TransformParameters()
        except Exception as error:
            raise HTTPException(status_code=400, detail=f"Invalid business transform: {error}") from error
        validate_transform(transform)
        task_id = str(uuid.uuid4())
        directory = tasks.directory(task_id)
        input_directory = directory / "input"
        input_directory.mkdir(parents=True)
        now = time.time()
        status: dict[str, Any] = {
            "task_id": task_id, "workspace_id": workspace, "owner_id": current_principal().key_id,
            "resource_token": secrets.token_urlsafe(32), "input_kind": input_kind,
            "business_transform": transform.model_dump(), "status": "queued",
            "cache_status": "not_requested", "cache_progress": None,
            "created_at_unix": now, "source_available": True,
            "source_expires_at_unix": now + tasks.retention_hours * 3600,
        }
        try:
            if input_kind == "lod_group":
                seen: set[str] = set()
                lods = []
                for index, upload in enumerate(files or []):
                    original = Path(upload.filename or "").name
                    if not original.lower().endswith(".ply"):
                        raise HTTPException(status_code=400, detail="LOD files must be Gaussian PLY")
                    path = input_directory / f"lod-{index}.ply"
                    size, digest = await save_upload_with_sha256(upload, path)
                    if size == 0 or digest in seen:
                        raise HTTPException(status_code=400, detail="LOD files must be non-empty and distinct")
                    seen.add(digest)
                    probe = probe_dataset(path)
                    if probe.format not in {"gaussian_ply", "compressed_ply"}:
                        raise HTTPException(status_code=400, detail="LOD files require supported Gaussian properties")
                    lods.append({"level": index, "name": original, "path": path.relative_to(directory).as_posix(),
                                 "bytes": size, "sha256": digest, "format": probe.format})
                status.update(lods=lods, format="lod_group", filename=lods[0]["name"])
            else:
                upload = file
                suffix = Path(upload.filename or "").suffix.lower() if upload else ".zip"
                if suffix not in {".ply", ".spz", ".sog", ".zip"}:
                    raise HTTPException(status_code=400, detail="Unsupported Gaussian input extension")
                path = input_directory / f"source{suffix}"
                size, digest = (await save_upload_with_sha256(upload, path) if upload else
                                await save_upload_directory_with_sha256(files or [], path))
                if size == 0:
                    raise HTTPException(status_code=400, detail="Uploaded dataset is empty")
                probe = probe_dataset(path)
                if probe.format not in GAUSSIAN_FORMATS:
                    raise HTTPException(status_code=400, detail="Only supported Gaussian datasets can be streamed")
                status.update(source_path=path.relative_to(directory).as_posix(), source_bytes=size,
                              source_sha256=digest, format=probe.format,
                              filename=Path(upload.filename or path.name).name if upload else "数据集目录")
            write_status(directory, status)
        except (DatasetFormatError, HTTPException) as error:
            shutil.rmtree(directory, ignore_errors=True)
            if isinstance(error, HTTPException):
                raise
            raise HTTPException(status_code=400, detail=str(error)) from error
        except Exception:
            shutil.rmtree(directory, ignore_errors=True)
            raise
        tasks.start(task_id, "prepare")
        return tasks.present(status)

    @router.get("")
    async def list_tasks(workspace_id: str) -> list[dict[str, Any]]:
        workspace = parse_workspace_id(workspace_id)
        if not tasks.root.is_dir():
            return []
        result = []
        for directory in tasks.root.iterdir():
            if not directory.is_dir():
                continue
            try:
                status = read_status(directory)
                authorize_resource(status)
            except (OSError, HTTPException, ValueError, json.JSONDecodeError):
                continue
            if status.get("workspace_id") == workspace:
                result.append(tasks.present(status))
        return sorted(result, key=lambda item: item.get("created_at_unix", 0), reverse=True)

    @router.get("/{task_id}")
    async def get_task(task_id: str) -> dict[str, Any]:
        _, status = tasks.read(task_id)
        return tasks.present(status)

    @router.put("/{task_id}/business-transform")
    async def update_transform(task_id: str, transform: TransformParameters) -> dict[str, Any]:
        validate_transform(transform)
        directory, status = tasks.read(task_id)
        status["business_transform"] = transform.model_dump()
        write_status(directory, status)
        return tasks.present(status)

    @router.post("/{task_id}/generate", status_code=202)
    async def generate(task_id: str) -> dict[str, Any]:
        directory, status = tasks.read(task_id)
        if status["status"] != "ready":
            raise HTTPException(status_code=409, detail="Model preview is not ready")
        if not status.get("source_available", True) and status.get("cache_status") != "ready":
            raise HTTPException(status_code=409, detail="Source data has been released")
        if status["cache_status"] in {"queued", "converting"}:
            return tasks.present(status)
        if status["cache_status"] == "ready":
            try:
                validate_streamed_sog_directory(directory / status.get("cache_path", "missing"))
            except (OSError, DatasetFormatError):
                pass
            else:
                return tasks.present(status)
        status.update(cache_status="queued", cache_error=None, cache_progress=None)
        write_status(directory, status)
        tasks.start(task_id, "generate")
        return tasks.present(status)

    @router.post("/{task_id}/retain")
    async def retain(task_id: str) -> dict[str, Any]:
        directory, status = tasks.read(task_id)
        if not status.get("source_available", True):
            raise HTTPException(status_code=409, detail="Source data has been released")
        status["source_expires_at_unix"] = time.time() + tasks.retention_hours * 3600
        write_status(directory, status)
        return tasks.present(status)

    @router.post("/{task_id}/release")
    async def release(task_id: str) -> dict[str, Any]:
        directory, status = tasks.read(task_id)
        tasks.release_source(task_id, directory, status)
        return tasks.present(status)

    @router.get("/{task_id}/preview")
    async def preview(task_id: str) -> FileResponse:
        directory, status = tasks.read(task_id)
        if status.get("status") != "ready":
            raise HTTPException(status_code=404, detail="Preview is not available")
        path = directory / "preview" / "model-points.bin"
        if not path.is_file():
            raise HTTPException(status_code=404, detail="Preview is missing")
        return _TaskFileResponse(path, media_type="application/octet-stream", tasks=tasks, task_id=task_id)

    @router.get("/{task_id}/download")
    async def download(task_id: str) -> StreamingResponse:
        directory, status = tasks.read(task_id)
        if status.get("cache_status") != "ready":
            raise HTTPException(status_code=404, detail="Streamed cache is not ready")
        entrypoint = directory / status["cache_path"]
        if not entrypoint.is_file():
            raise HTTPException(status_code=404, detail="Streamed cache is missing")
        file_count, source_bytes = directory_zip_metadata(entrypoint.parent)

        filename = f"{Path(status['filename']).stem}-streamed-sog.zip"
        return _TaskStreamingResponse(stream_directory_zip(entrypoint.parent), tasks=tasks, task_id=task_id,
                                      media_type="application/zip", headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
            "X-Cache-File-Count": str(file_count), "X-Cache-Source-Bytes": str(source_bytes),
        })

    return router


def create_streaming_resource_router(tasks: StreamingTasks) -> APIRouter:
    router = APIRouter()

    @router.get("/streaming-resources/{task_id}/{token}/{resource_path:path}")
    async def resource(task_id: str, token: str, resource_path: str) -> FileResponse:
        directory = tasks.directory(task_id)
        status = read_status(directory)
        if not hmac.compare_digest(token, status["resource_token"]):
            raise HTTPException(status_code=404, detail="Resource not found")
        relative = Path(resource_path.replace("\\", "/"))
        if not relative.parts or relative.parts[0] not in {"input", "datasets", "output"}:
            raise HTTPException(status_code=404, detail="Resource not found")
        root = (directory / relative.parts[0]).resolve()
        path = (directory / relative).resolve()
        if (directory.resolve() not in root.parents or root not in path.parents
                or not path.is_file() or path.suffix.lower() not in {
            ".json", ".webp", ".ply", ".spz", ".sog", ".lcc", ".lcc2", ".bin",
        }):
            raise HTTPException(status_code=404, detail="Resource not found")
        media = {".json": "application/json", ".webp": "image/webp"}
        return _TaskFileResponse(path, media_type=media.get(path.suffix.lower(), "application/octet-stream"),
                                 tasks=tasks, task_id=task_id)

    return router
