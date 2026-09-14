import asyncio
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from service.cleanup import cleanup_completed_jobs, run_cleanup_loop


class CleanupLoopTest(unittest.IsolatedAsyncioTestCase):
    async def test_cleanup_completes_before_waiting_and_cancellation_stops_loop(self):
        calls = []
        cleanup = Mock()

        async def run_in_thread(callback):
            self.assertIs(callback, cleanup)
            calls.append("cleanup")

        async def wait(interval):
            self.assertEqual(interval, 17)
            calls.append("wait")
            if len(calls) == 4:
                raise asyncio.CancelledError

        with patch("service.cleanup.asyncio.to_thread", side_effect=run_in_thread), \
             patch("service.cleanup.asyncio.sleep", side_effect=wait):
            with self.assertRaises(asyncio.CancelledError):
                await run_cleanup_loop(cleanup, 17)
        self.assertEqual(calls, ["cleanup", "wait", "cleanup", "wait"])

    async def test_cleanup_failure_propagates_without_waiting_or_retrying(self):
        failure = OSError("cleanup unavailable")
        with patch("service.cleanup.asyncio.to_thread", new_callable=AsyncMock,
                   side_effect=failure) as run_in_thread, \
             patch("service.cleanup.asyncio.sleep", new_callable=AsyncMock) as wait:
            with self.assertRaises(OSError) as caught:
                await run_cleanup_loop(Mock(), 17)
        self.assertIs(caught.exception, failure)
        run_in_thread.assert_awaited_once()
        wait.assert_not_awaited()


class CleanupTest(unittest.TestCase):
    def test_running_jobs_are_preserved_and_expired_results_are_cleaned(self):
        root = Path("runtime/test-cleanup")
        running = root / "jobs" / "00000000-0000-0000-0000-000000000001"
        completed = root / "jobs" / "00000000-0000-0000-0000-000000000002"
        invalid = root / "jobs" / "unmanaged"
        statuses = {
            running: {"status": "running", "updated_at_unix": 0},
            completed: {"status": "succeeded", "updated_at_unix": 0},
        }
        release = Mock()
        with patch.object(Path, "is_dir", return_value=True), \
             patch.object(Path, "iterdir", side_effect=[[running, completed, invalid], []]), \
             patch("service.cleanup.shutil.rmtree") as remove:
            cleanup_completed_jobs(root, 24, lambda job: root / "jobs" / job,
                                   lambda path: statuses[path], Mock(), release)
        self.assertEqual([call.args[0] for call in remove.call_args_list],
                         [completed / "input", completed])
        release.assert_not_called()

    def test_expired_source_is_released_but_active_session_is_preserved(self):
        root = Path("runtime/test-cleanup")
        idle = root / "manual-sessions" / "00000000-0000-0000-0000-000000000001"
        active = root / "manual-sessions" / "00000000-0000-0000-0000-000000000002"
        job = root / "jobs" / "job"
        statuses = {
            idle: {"api_version": "v2", "status": "ready", "source_expires_at_unix": 0},
            active: {"api_version": "v2", "status": "ready", "active_job_id": "job", "source_expires_at_unix": 0},
            job: {"status": "running"},
        }
        release = Mock()
        with patch.object(Path, "is_dir", return_value=True), \
             patch.object(Path, "iterdir", side_effect=[[], [idle, active]]), \
             patch("service.cleanup.shutil.rmtree") as remove:
            cleanup_completed_jobs(root, 24, lambda _: job, lambda path: statuses[path],
                                   lambda *_: True, release)
        release.assert_called_once_with(idle, statuses[idle])
        remove.assert_not_called()
