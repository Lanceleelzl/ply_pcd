"""Desktop-only jobs. Disk paths come exclusively from the native file picker."""
import asyncio
import hashlib
import os
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from service.auth import current_principal
from service.copc_converter import convert, validate_companion


class Source(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    size: int = Field(gt=0)
    fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")


def local_only(request: Request):
    local = {"127.0.0.1", "::1", "localhost"}
    origin = request.headers.get("origin")
    if (os.name != "nt" or not request.client or request.client.host not in local
            or request.url.hostname not in local or (origin and urlsplit(origin).hostname not in local)):
        raise HTTPException(403, "COPC 转换需要在本机打开高斯浏览。")


def recent_las_directory(source: Source):
    """Browsers omit absolute paths. Resolve a matching recent picker entry on Windows."""
    import ctypes
    import winreg

    base = r"Software\Microsoft\Windows\CurrentVersion\Explorer\ComDlg32\OpenSavePidlMRU"
    for group in ("*", "las", "Folder"):
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, base + "\\" + group) as key:
                order = winreg.QueryValueEx(key, "MRUListEx")[0]
                for offset in range(0, len(order) - 3, 4):
                    index = int.from_bytes(order[offset:offset + 4], "little")
                    if index == 0xffffffff:
                        break
                    pidl = winreg.QueryValueEx(key, str(index))[0]
                    buf = ctypes.create_unicode_buffer(32768)
                    if not ctypes.windll.shell32.SHGetPathFromIDListW(pidl, buf):
                        continue
                    path = Path(buf.value)
                    candidate = path if path.name.casefold() == source.name.casefold() else path / source.name
                    try:
                        if candidate.is_file() and matches(source, candidate):
                            return str(candidate.parent)
                    except OSError:
                        continue
        except OSError:
            continue
    return ""


async def choose_las(source: Source):
    directory = await asyncio.to_thread(recent_las_directory, source)
    script = """
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Select the original LAS for local COPC conversion'
$dialog.Filter = 'LAS (*.las)|*.las'
if ($env:COPC_INITIAL_DIRECTORY) { $dialog.InitialDirectory = $env:COPC_INITIAL_DIRECTORY }
$dialog.FileName = $env:COPC_EXPECTED_NAME
if ($dialog.ShowDialog() -eq 'OK') { [Console]::Write($dialog.FileName) }
"""
    proc = await asyncio.create_subprocess_exec(
        "powershell.exe", "-NoProfile", "-STA", "-Command", script,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env={**os.environ, "COPC_EXPECTED_NAME": source.name, "COPC_INITIAL_DIRECTORY": directory}, creationflags=0x08000000)
    output, _ = await proc.communicate()
    if proc.returncode:
        raise RuntimeError("无法打开本机文件选择器")
    return Path(output.decode("utf-8-sig")) if output else None


def matches(source: Source, path: Path):
    if path.name.casefold() != source.name.casefold() or path.stat().st_size != source.size:
        return False
    with path.open("rb") as f:
        first = f.read(65536)
        f.seek(max(0, source.size - 65536))
        return hashlib.sha256(first + f.read(65536)).hexdigest() == source.fingerprint


def create_copc_router():
    router = APIRouter(prefix="/api/copc", dependencies=[Depends(local_only)])
    jobs = {}
    workers = set()
    conversion = asyncio.Semaphore(1)
    picker = asyncio.Lock()

    def view(job):
        return {k: job[k] for k in ("id", "name", "status", "error")}

    async def run(job, path):
        try:
            async with conversion:
                job["status"] = "converting"
                if job["output"].is_file():
                    await asyncio.to_thread(validate_companion, path, job["output"])
                else:
                    await asyncio.to_thread(convert, path, job["output"])
            job["status"] = "ready"
        except Exception as exc:
            job.update(status="failed", error=str(exc))

    @router.post("/jobs", status_code=202)
    async def submit(source: Source):
        if Path(source.name).name != source.name or not source.name.lower().endswith(".las"):
            raise HTTPException(422, "请选择 LAS 文件")
        if picker.locked():
            raise HTTPException(409, "请先完成已打开的文件选择")
        async with picker:
            path = await choose_las(source)
        if path is None:
            raise HTTPException(409, "已取消转换")
        if not matches(source, path):
            raise HTTPException(422, "选择的文件与当前图层不一致")
        owner = current_principal().key_id
        output = path.with_suffix(".copc.laz")
        for job in jobs.values():
            if job["owner"] == owner and job["output"] == output and job["status"] in ("queued", "converting"):
                return view(job)
        job = dict(id=uuid4().hex, name=source.name, owner=owner, output=output, status="queued", error="")
        jobs[job["id"]] = job
        task = asyncio.create_task(run(job, path))
        workers.add(task)
        task.add_done_callback(workers.discard)
        return view(job)

    @router.get("/jobs")
    def listing():
        return [view(j) for j in reversed(list(jobs.values())) if j["owner"] == current_principal().key_id][:100]

    @router.get("/jobs/{job_id}")
    def status(job_id: str):
        job = jobs.get(job_id)
        if not job or job["owner"] != current_principal().key_id:
            raise HTTPException(404, "未找到转换任务")
        return view(job)

    @router.get("/jobs/{job_id}/result")
    def result(job_id: str):
        if status(job_id)["status"] != "ready":
            raise HTTPException(409, "转换结果尚未就绪")
        path = jobs[job_id]["output"]
        if not path.is_file():
            raise HTTPException(404, "转换结果已移动")
        return FileResponse(path, media_type="application/octet-stream")

    return router
