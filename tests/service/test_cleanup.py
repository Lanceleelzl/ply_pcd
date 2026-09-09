import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from service.cleanup import cleanup_completed_jobs


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
