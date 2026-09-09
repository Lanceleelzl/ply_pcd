import asyncio
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from service.registration_tasks import run_registration_task


class RegistrationTaskTest(unittest.IsolatedAsyncioTestCase):
    async def run_case(self, *, exit_code=0, result_exists=True, cancelled=False, timeout=False):
        status = {"job_id": "test-job", "status": "queued"}
        writes = []
        processes = {}
        process = Mock()
        process.returncode = exit_code
        process.stdout.readline = AsyncMock(return_value=b"")
        process.stderr.read = AsyncMock(return_value=b"worker error" if exit_code else b"")
        process.wait = AsyncMock()
        process.communicate = AsyncMock(return_value=(b"", b""))
        if timeout:
            process.wait.side_effect = asyncio.TimeoutError

        def read_status(_):
            if cancelled and processes:
                return {**status, "status": "cancelled"}
            return dict(status)

        def write_status(_, value):
            status.update(value)
            writes.append(dict(value))

        sync = Mock()
        with patch("service.registration_tasks.asyncio.create_subprocess_exec", return_value=process), \
             patch.object(Path, "is_file", return_value=result_exists), \
             patch.object(Path, "write_bytes"), \
             patch("service.registration_tasks.shutil.rmtree"):
            await run_registration_task(
                "test-job", ["worker"],
                resolve_job_directory=lambda _: Path("runtime/jobs/test-job"),
                session_directory=lambda _: Path("runtime/manual-sessions/test-session"),
                read_status=read_status, write_status=write_status, sync_session_job=sync,
                semaphore=asyncio.Semaphore(1), running_processes=processes, timeout_seconds=10,
            )
        self.assertEqual(processes, {})
        self.assertEqual(writes[0]["status"], "running")
        self.assertIn("finished_at_unix", writes[-1])
        self.assertEqual(sync.call_args.args[0]["status"], writes[-1]["status"])
        return writes[-1], process

    async def test_success_sets_result_url(self):
        status, _ = await self.run_case()
        self.assertEqual(status["status"], "succeeded")
        self.assertEqual(status["result_url"], "/api/v2/registrations/test-job/result")

    async def test_failed_worker_preserves_exit_code_and_error(self):
        status, _ = await self.run_case(exit_code=50)
        self.assertEqual(status["status"], "failed")
        self.assertEqual(status["worker_exit_code"], 50)
        self.assertEqual(status["error"], "worker error")

    async def test_missing_result_does_not_report_success(self):
        status, _ = await self.run_case(result_exists=False)
        self.assertEqual(status["status"], "failed")
        self.assertEqual(status["error_code"], "missing_result")

    async def test_cancellation_wins_over_worker_success(self):
        status, process = await self.run_case(cancelled=True)
        self.assertEqual(status["status"], "cancelled")
        self.assertNotIn("result_url", status)
        process.kill.assert_called_once()

    async def test_timeout_kills_and_reaps_worker(self):
        status, process = await self.run_case(timeout=True)
        self.assertEqual(status["status"], "failed")
        self.assertEqual(status["error_code"], "worker_timeout")
        process.kill.assert_called_once()
        process.communicate.assert_awaited_once()
