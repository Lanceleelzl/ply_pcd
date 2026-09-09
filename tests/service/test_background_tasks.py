import asyncio
import unittest

from service.background_tasks import BackgroundTasks


class BackgroundTasksTest(unittest.IsolatedAsyncioTestCase):
    async def test_pending_task_is_retained_then_released(self):
        registry = BackgroundTasks()
        ready = asyncio.Event()

        async def work():
            await ready.wait()

        task = registry.start(work())
        await asyncio.sleep(0)
        self.assertIn(task, registry.tasks)
        ready.set()
        await task
        self.assertEqual(registry.tasks, set())

    async def test_failure_is_released_and_remains_observable(self):
        registry = BackgroundTasks()

        async def work():
            raise RuntimeError("failed task")

        task = registry.start(work())
        with self.assertRaisesRegex(RuntimeError, "failed task"):
            await task
        self.assertEqual(registry.tasks, set())

    async def test_cancellation_is_released(self):
        registry = BackgroundTasks()

        async def work():
            await asyncio.Event().wait()

        task = registry.start(work())
        await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(registry.tasks, set())
