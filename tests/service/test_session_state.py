import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from service.session_state import normalize_task_links, source_available, sync_session_job


class SessionStateTest(unittest.TestCase):
    def setUp(self):
        self.directory = Path("runtime/manual-sessions/session")
        self.entry = {"job_id": "job", "status": "queued", "initial_matrix": [1, 2]}
        self.session = {
            "api_version": "v2", "active_job_id": "job", "registrations": [self.entry],
        }
        self.resolve = Mock(return_value=self.directory)
        self.read = Mock(return_value=self.session)
        self.write = Mock()
        self.history = Mock()

    def sync(self, status, **fields):
        sync_session_job(
            {"manual_session_id": "session", "job_id": "job", "status": status, **fields},
            resolve_session_directory=self.resolve, read_status=self.read,
            write_status=self.write, write_history=self.history,
        )

    def test_running_updates_only_task_fields(self):
        self.sync("running", started_at_unix=123, initial_matrix=[9])
        self.assertEqual(self.entry, {
            "job_id": "job", "status": "running", "initial_matrix": [1, 2],
            "started_at_unix": 123,
        })
        self.assertEqual(self.session["active_job_id"], "job")
        self.write.assert_called_once_with(self.directory, self.session)
        self.history.assert_not_called()

    def test_terminal_states_release_only_the_matching_active_job(self):
        for status in ("succeeded", "failed", "cancelled"):
            for active, expected in (("job", None), ("newer-job", "newer-job")):
                with self.subTest(status=status, active=active):
                    self.session["active_job_id"] = active
                    self.sync(status, finished_at_unix=456)
                    self.assertEqual(self.session["active_job_id"], expected)
                    self.assertEqual(self.entry["status"], status)
                    self.assertEqual(self.entry["finished_at_unix"], 456)

    def test_success_persists_session_before_archiving(self):
        calls = []
        self.write.side_effect = lambda *args: calls.append("status")
        self.history.side_effect = lambda *args: calls.append("history")
        self.sync("succeeded", result_url="/api/v2/registrations/job/result")
        self.assertEqual(calls, ["status", "history"])
        self.history.assert_called_once_with(self.directory, self.session)
        self.assertEqual(self.entry["result_url"], "/api/v2/registrations/job/result")

    def test_expected_archive_failure_preserves_completed_session(self):
        for error in (OSError("unavailable"), ValueError("invalid archive")):
            with self.subTest(error=error):
                self.history.side_effect = error
                self.sync("succeeded")
                self.assertEqual(self.entry["status"], "succeeded")
                self.assertIsNone(self.session["active_job_id"])
        self.assertEqual(self.write.call_count, 2)

    def test_legacy_session_success_is_not_archived_as_v2(self):
        self.session["api_version"] = "v1"
        self.sync("succeeded")
        self.write.assert_called_once()
        self.history.assert_not_called()

    def test_missing_session_or_registration_does_not_write(self):
        self.sync("running", manual_session_id=None)
        self.resolve.assert_not_called()
        self.read.assert_not_called()
        self.session["registrations"] = []
        self.sync("running")
        self.write.assert_not_called()
        self.history.assert_not_called()
        self.assertEqual(self.session["active_job_id"], "job")

    def test_links_preserve_unrelated_urls_and_fields(self):
        status = {"result_url": "/api/v1/registrations/job/result", "registrations": [
            {"status_url": "/api/v1/registrations/job", "progress_url": None,
             "result_url": "https://example.com/api/v1/registrations/job/result",
             "filename": "/api/v1/registrations/data"},
        ]}
        result = normalize_task_links(status)
        self.assertEqual(result["result_url"], "/api/v2/registrations/job/result")
        entry = result["registrations"][0]
        self.assertEqual(entry["status_url"], "/api/v2/registrations/job")
        self.assertIsNone(entry["progress_url"])
        self.assertEqual(entry["result_url"], "https://example.com/api/v1/registrations/job/result")
        self.assertEqual(entry["filename"], "/api/v1/registrations/data")

    def test_source_availability_requires_both_model_files(self):
        status = {"model_a_filename": "a.ply", "model_b_filename": "b.pcd"}
        for existing in ({"a.ply", "b.pcd"}, {"a.ply"}, {"b.pcd"}, set()):
            with self.subTest(existing=existing), patch.object(
                Path, "is_file", autospec=True,
                side_effect=lambda path: path.name in existing,
            ):
                self.assertEqual(source_available(self.directory, status), len(existing) == 2)
        with patch.object(Path, "is_file", autospec=True, side_effect=lambda path: path.name == "a.ply"):
            self.assertFalse(source_available(self.directory, {"model_a_filename": "a.ply"}))
