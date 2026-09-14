# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import os
from pathlib import Path

from service.object_storage import ObjectStorageSettings


RUNTIME_ROOT = Path(os.getenv("REGISTRATION_RUNTIME_ROOT", "/data/runtime")).resolve()
WORKER_PATH = os.getenv("REGISTRATION_WORKER_PATH", "/usr/local/bin/registration_worker")
WORKER_TIMEOUT_SECONDS = int(os.getenv("REGISTRATION_WORKER_TIMEOUT_SECONDS", "1800"))
MAX_CONCURRENT_JOBS = int(os.getenv("REGISTRATION_MAX_CONCURRENT_JOBS", "1"))
RESULT_RETENTION_HOURS = int(os.getenv("REGISTRATION_RESULT_RETENTION_HOURS", "168"))
CLEANUP_INTERVAL_SECONDS = int(os.getenv("REGISTRATION_CLEANUP_INTERVAL_SECONDS", "3600"))
SOURCE_RETENTION_HOURS = int(os.getenv("REGISTRATION_SOURCE_RETENTION_HOURS", "24"))
UPLOAD_CHUNK_BYTES = 1024 * 1024
SERVICE_VERSION = "0.3.0"
OBJECT_STORAGE_SETTINGS = ObjectStorageSettings(
    backend=os.getenv("REGISTRATION_OBJECT_STORAGE_BACKEND", "local"),
    bucket=os.getenv("REGISTRATION_S3_BUCKET", ""),
    prefix=os.getenv("REGISTRATION_S3_PREFIX", "registration"),
    endpoint_url=os.getenv("REGISTRATION_S3_ENDPOINT_URL") or None,
    region=os.getenv("REGISTRATION_S3_REGION") or None,
    addressing_style=os.getenv("REGISTRATION_S3_ADDRESSING_STYLE", "auto"),
)
AUTH_ENABLED = os.getenv("REGISTRATION_AUTH_ENABLED", "false").lower() in {"1", "true", "yes"}
API_KEY_HASHES = os.getenv("REGISTRATION_API_KEY_HASHES", "")
