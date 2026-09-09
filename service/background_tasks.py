# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import asyncio
from collections.abc import Coroutine
from typing import Any


class BackgroundTasks:
    """Keep scheduled coroutines alive until their tasks finish."""

    def __init__(self) -> None:
        self.tasks: set[asyncio.Task[None]] = set()

    def start(self, coroutine: Coroutine[Any, Any, None]) -> asyncio.Task[None]:
        task = asyncio.create_task(coroutine)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task
