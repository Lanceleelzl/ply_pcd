# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError


@dataclass(frozen=True)
class ObjectStorageSettings:
    backend: str = "local"
    bucket: str = ""
    prefix: str = "registration"
    endpoint_url: str | None = None
    region: str | None = None
    addressing_style: str = "auto"


class LocalObjectStorage:
    enabled = False


class S3ObjectStorage:
    enabled = True

    def __init__(self, settings: ObjectStorageSettings, *, client: Any | None = None) -> None:
        if not settings.bucket:
            raise ValueError("REGISTRATION_S3_BUCKET is required for the s3 backend")
        if settings.addressing_style not in {"auto", "path", "virtual"}:
            raise ValueError("REGISTRATION_S3_ADDRESSING_STYLE must be auto, path, or virtual")
        self.bucket = settings.bucket
        self.prefix = settings.prefix.strip("/")
        self.client = client or boto3.client(
            "s3",
            endpoint_url=settings.endpoint_url,
            region_name=settings.region,
            config=Config(s3={"addressing_style": settings.addressing_style}),
        )

    def key(self, *parts: str) -> str:
        normalized = []
        for part in parts:
            value = part.strip("/")
            if not value or value in {".", ".."} or "\\" in value or "/../" in f"/{value}/":
                raise ValueError("Invalid object key part")
            normalized.append(value)
        return "/".join(([self.prefix] if self.prefix else []) + normalized)

    def upload_file(self, source: Path, key: str) -> None:
        self.client.upload_file(str(source), self.bucket, key)

    def download_file(self, key: str, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(destination.name + ".download")
        self.client.download_file(self.bucket, key, str(temporary))
        temporary.replace(destination)

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
            return True
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}:
                return False
            raise

    def delete_prefix(self, prefix: str) -> None:
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            keys = [{"Key": item["Key"]} for item in page.get("Contents", [])]
            if keys:
                self.client.delete_objects(Bucket=self.bucket, Delete={"Objects": keys, "Quiet": True})


def create_object_storage(settings: ObjectStorageSettings) -> LocalObjectStorage | S3ObjectStorage:
    if settings.backend == "local":
        return LocalObjectStorage()
    if settings.backend == "s3":
        return S3ObjectStorage(settings)
    raise ValueError("REGISTRATION_OBJECT_STORAGE_BACKEND must be local or s3")
