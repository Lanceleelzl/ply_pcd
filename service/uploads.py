# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import hashlib
from pathlib import Path

from fastapi import UploadFile

from service.config import UPLOAD_CHUNK_BYTES


async def save_upload(upload: UploadFile, destination: Path) -> int:
    total = 0
    with destination.open("wb") as output:
        while chunk := await upload.read(UPLOAD_CHUNK_BYTES):
            output.write(chunk)
            total += len(chunk)
    await upload.close()
    return total


async def save_upload_with_sha256(upload: UploadFile, destination: Path) -> tuple[int, str]:
    total = 0
    digest = hashlib.sha256()
    with destination.open("wb") as output:
        while chunk := await upload.read(UPLOAD_CHUNK_BYTES):
            output.write(chunk)
            digest.update(chunk)
            total += len(chunk)
    await upload.close()
    return total, digest.hexdigest()
