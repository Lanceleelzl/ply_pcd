# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import hashlib
import zipfile
from pathlib import Path
from pathlib import PurePosixPath

from fastapi import UploadFile

from service.config import UPLOAD_CHUNK_BYTES
from service.dataset_formats import MAX_DATASET_FILES, MAX_DATASET_UNCOMPRESSED_BYTES, DatasetFormatError


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


async def save_upload_directory_with_sha256(uploads: list[UploadFile], destination: Path) -> tuple[int, str]:
    if not uploads or len(uploads) > MAX_DATASET_FILES:
        raise DatasetFormatError(f"Dataset directory must contain 1 to {MAX_DATASET_FILES} files")
    names: set[str] = set()
    total = 0
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
        for upload in uploads:
            name = (upload.filename or "").replace("\\", "/")
            path = PurePosixPath(name)
            if not name or path.is_absolute() or ".." in path.parts or (path.parts and ":" in path.parts[0]):
                raise DatasetFormatError(f"Unsafe dataset path: {name or '<empty>'}")
            normalized = str(path)
            if normalized in names:
                raise DatasetFormatError(f"Duplicate dataset path: {normalized}")
            names.add(normalized)
            with archive.open(normalized, "w", force_zip64=True) as output:
                while chunk := await upload.read(UPLOAD_CHUNK_BYTES):
                    total += len(chunk)
                    if total > MAX_DATASET_UNCOMPRESSED_BYTES:
                        raise DatasetFormatError("Dataset directory size exceeds 100 GiB")
                    output.write(chunk)
            await upload.close()
    digest = hashlib.sha256()
    with destination.open("rb") as stream:
        while chunk := stream.read(UPLOAD_CHUNK_BYTES):
            digest.update(chunk)
    return total, digest.hexdigest()
