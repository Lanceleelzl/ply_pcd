import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from service.registration_queue import (
    read_task_descriptor,
    recover_registration_queue,
    write_task_descriptor,
)


class RegistrationQueueTest(unittest.TestCase):
    def test_descriptor_round_trip_is_atomic_and_private(self):
        with tempfile.TemporaryDirectory() as temporary:
            job_directory = Path(temporary) / "job"
            job_directory.mkdir()
            write_task_descriptor(job_directory, ["worker", "register-models", "--progress-jsonl"])

            self.assertEqual(
                read_task_descriptor(job_directory),
                ["worker", "register-models", "--progress-jsonl"],
            )
            self.assertFalse((job_directory / "task.json.tmp").exists())

    def test_startup_requeues_queued_jobs_and_settles_interrupted_jobs(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime_root = Path(temporary)
            jobs = runtime_root / "jobs"
            queued = jobs / "00000000-0000-0000-0000-000000000001"
            running = jobs / "00000000-0000-0000-0000-000000000002"
            succeeded = jobs / "00000000-0000-0000-0000-000000000003"
            for directory, status in ((queued, "queued"), (running, "running"), (succeeded, "succeeded")):
                directory.mkdir(parents=True)
                (directory / "status.json").write_text(
                    json.dumps({"job_id": directory.name, "status": status, "manual_session_id": "session"}),
                    encoding="utf-8",
                )
            write_task_descriptor(queued, ["worker", "register-models"])

            started = Mock()
            synced = Mock()
            writes = []

            def read_status(directory):
                return json.loads((directory / "status.json").read_text(encoding="utf-8"))

            def write_status(directory, status):
                writes.append((directory.name, dict(status)))
                (directory / "status.json").write_text(json.dumps(status), encoding="utf-8")

            result = recover_registration_queue(
                runtime_root,
                read_status=read_status,
                write_status=write_status,
                sync_session_job=synced,
                start_registration=started,
                now=lambda: 123.0,
            )

            started.assert_called_once_with(queued.name, ["worker", "register-models"])
            self.assertEqual(result, {"requeued": 1, "failed": 1, "ignored": 1})
            interrupted = read_status(running)
            self.assertEqual(interrupted["status"], "failed")
            self.assertEqual(interrupted["error_code"], "service_restarted")
            self.assertEqual(interrupted["finished_at_unix"], 123.0)
            synced.assert_called_once_with(interrupted)

    def test_missing_or_invalid_descriptor_settles_queued_job(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime_root = Path(temporary)
            jobs = runtime_root / "jobs"
            missing = jobs / "00000000-0000-0000-0000-000000000004"
            invalid = jobs / "00000000-0000-0000-0000-000000000005"
            for directory in (missing, invalid):
                directory.mkdir(parents=True)
                (directory / "status.json").write_text(
                    json.dumps({"job_id": directory.name, "status": "queued"}), encoding="utf-8"
                )
            (invalid / "task.json").write_text('{"version":1,"command":[]}', encoding="utf-8")

            started = Mock()
            synced = Mock()

            def read_status(directory):
                return json.loads((directory / "status.json").read_text(encoding="utf-8"))

            def write_status(directory, status):
                (directory / "status.json").write_text(json.dumps(status), encoding="utf-8")

            result = recover_registration_queue(
                runtime_root,
                read_status=read_status,
                write_status=write_status,
                sync_session_job=synced,
                start_registration=started,
                now=lambda: 456.0,
            )

            self.assertEqual(result, {"requeued": 0, "failed": 2, "ignored": 0})
            started.assert_not_called()
            self.assertEqual(synced.call_count, 2)
            for directory in (missing, invalid):
                status = read_status(directory)
                self.assertEqual(status["status"], "failed")
                self.assertEqual(status["error_code"], "queue_descriptor_invalid")

    def test_scheduler_or_missing_session_does_not_abort_startup_scan(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime_root = Path(temporary)
            job_directory = runtime_root / "jobs" / "00000000-0000-0000-0000-000000000006"
            job_directory.mkdir(parents=True)
            status = {"job_id": job_directory.name, "status": "queued", "manual_session_id": "missing"}
            (job_directory / "status.json").write_text(json.dumps(status), encoding="utf-8")
            write_task_descriptor(job_directory, ["worker", "register-models"])

            def read_status(directory):
                return json.loads((directory / "status.json").read_text(encoding="utf-8"))

            def write_status(directory, value):
                (directory / "status.json").write_text(json.dumps(value), encoding="utf-8")

            result = recover_registration_queue(
                runtime_root,
                read_status=read_status,
                write_status=write_status,
                sync_session_job=Mock(side_effect=FileNotFoundError("session removed")),
                start_registration=Mock(side_effect=RuntimeError("scheduler unavailable")),
                now=lambda: 789.0,
            )

            self.assertEqual(result, {"requeued": 0, "failed": 1, "ignored": 0})
            failed = read_status(job_directory)
            self.assertEqual(failed["status"], "failed")
            self.assertEqual(failed["error_code"], "queue_start_failed")
