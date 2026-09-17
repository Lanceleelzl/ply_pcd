# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import io
import hashlib
import json
import queue
import threading
import zipfile
from collections.abc import Iterator
from pathlib import Path


MANIFEST_NAME = "cache-manifest.json"


class _QueueWriter(io.RawIOBase):
    def __init__(self, chunks: queue.Queue[bytes | BaseException | None], stopped: threading.Event) -> None:
        self.chunks = chunks
        self.stopped = stopped
        self.offset = 0

    def writable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return False

    def tell(self) -> int:
        return self.offset

    def write(self, data: bytes | bytearray) -> int:
        value = bytes(data)
        while value:
            if self.stopped.is_set():
                raise BrokenPipeError("ZIP download was cancelled")
            try:
                self.chunks.put(value, timeout=0.1)
                break
            except queue.Full:
                continue
        self.offset += len(value)
        return len(value)


def directory_zip_metadata(root: Path) -> tuple[int, int]:
    files = [path for path in root.resolve().rglob("*") if path.is_file() and path.name != MANIFEST_NAME]
    return len(files), sum(path.stat().st_size for path in files)


def stream_directory_zip(root: Path) -> Iterator[bytes]:
    root = root.resolve()
    files = sorted(path for path in root.rglob("*") if path.is_file() and path.name != MANIFEST_NAME)
    chunks: queue.Queue[bytes | BaseException | None] = queue.Queue(maxsize=8)
    stopped = threading.Event()

    def publish(value: bytes | BaseException | None) -> None:
        while not stopped.is_set():
            try:
                chunks.put(value, timeout=0.1)
                return
            except queue.Full:
                continue

    def produce() -> None:
        try:
            writer = _QueueWriter(chunks, stopped)
            manifest_files: list[dict[str, str | int]] = []
            with zipfile.ZipFile(writer, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
                for path in files:
                    digest = hashlib.sha256()
                    size = 0
                    with path.open("rb") as source, archive.open(
                        path.relative_to(root).as_posix(), "w", force_zip64=True,
                    ) as destination:
                        while block := source.read(1024 * 1024):
                            digest.update(block)
                            size += len(block)
                            destination.write(block)
                    manifest_files.append({
                        "path": path.relative_to(root).as_posix(),
                        "bytes": size,
                        "sha256": digest.hexdigest(),
                    })
                archive.writestr(MANIFEST_NAME, json.dumps({
                    "schema_version": 1,
                    "hash_algorithm": "sha256",
                    "files": manifest_files,
                }, ensure_ascii=False, separators=(",", ":")))
        except BrokenPipeError:
            pass
        except BaseException as error:
            publish(error)
        finally:
            publish(None)

    producer = threading.Thread(target=produce, name="streamed-sog-zip", daemon=True)
    producer.start()
    try:
        while True:
            item = chunks.get()
            if item is None:
                return
            if isinstance(item, BaseException):
                raise item
            yield item
    finally:
        stopped.set()
