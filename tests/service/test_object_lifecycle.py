import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from service.object_lifecycle import (
    archive_job_result,
    archive_session_sources,
    delete_session_objects,
    restore_session_sources,
    restore_job_result,
    source_available_locally_or_remotely,
)


class ObjectLifecycleTest(unittest.TestCase):
    def setUp(self):
        self.store = Mock(enabled=True)
        self.store.key.side_effect = lambda *parts: "/".join(parts)
        self.status = {
            "session_id": "session", "model_a_filename": "a.ply", "model_b_filename": "b.pcd",
            "registrations": [{"job_id": "job"}],
        }

    def test_archive_and_restore_sources(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            inputs = directory / "input"
            inputs.mkdir()
            (inputs / "a.ply").write_bytes(b"a")
            (inputs / "b.pcd").write_bytes(b"b")
            archive_session_sources(self.store, directory, self.status)
            self.assertEqual(self.store.upload_file.call_count, 2)
            self.assertTrue(self.status["object_storage"]["source_available"])

            (inputs / "a.ply").unlink()
            self.store.download_file.side_effect = lambda _key, path: path.write_bytes(b"restored")
            self.assertTrue(restore_session_sources(self.store, directory, self.status))
            self.assertEqual((inputs / "a.ply").read_bytes(), b"restored")
            self.assertTrue(source_available_locally_or_remotely(directory, self.status))

    def test_result_archive_and_release_use_managed_prefixes(self):
        with tempfile.TemporaryDirectory() as temporary:
            result = Path(temporary)
            (result / "registration.json").write_text("{}", encoding="utf-8")
            archive_job_result(self.store, "job", result)
        self.store.upload_file.assert_called_once()
        self.status["object_storage"] = {"source_available": True}
        delete_session_objects(self.store, self.status)
        self.assertEqual(
            [call.args[0] for call in self.store.delete_prefix.call_args_list],
            ["sessions/session/", "jobs/job/"],
        )
        self.assertFalse(self.status["object_storage"]["source_available"])

    def test_missing_result_is_restored_from_managed_key(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "result" / "registration.json"
            def download(_key, path):
                path.parent.mkdir(parents=True)
                path.write_text("{}", encoding="utf-8")
            self.store.download_file.side_effect = download
            self.assertTrue(restore_job_result(self.store, "job", "registration.json", destination))
            self.assertEqual(destination.read_text(encoding="utf-8"), "{}")
            self.store.download_file.assert_called_once_with(
                "jobs/job/result/registration.json", destination
            )

    def test_local_backend_is_noop(self):
        local = Mock(enabled=False)
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            archive_session_sources(local, directory, self.status)
            archive_job_result(local, "job", directory)
        delete_session_objects(local, self.status)
        local.upload_file.assert_not_called()
        local.delete_prefix.assert_not_called()
