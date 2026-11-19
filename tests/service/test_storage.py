import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from service.storage import read_status, write_status


class StatusStorageTest(unittest.TestCase):
    def test_retries_transient_windows_read_denial(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            write_status(directory, {"status": "ready"})
            with patch.object(Path, "read_text", autospec=True, side_effect=[
                PermissionError(13, "Permission denied"), PermissionError(13, "Permission denied"),
                '{"status": "ready"}',
            ]) as read, patch("service.storage.time.sleep") as sleep:
                self.assertEqual(read_status(directory)["status"], "ready")
            self.assertEqual(read.call_count, 3)
            self.assertEqual([call.args[0] for call in sleep.call_args_list], [0.02, 0.04])

    def test_persistent_read_denial_remains_an_error_after_bounded_retries(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            write_status(directory, {"status": "ready"})
            error = PermissionError(13, "Permission denied")
            with patch.object(Path, "read_text", autospec=True, side_effect=error) as read, \
                 patch("service.storage.time.sleep") as sleep:
                with self.assertRaises(PermissionError) as caught:
                    read_status(directory)
            self.assertIs(caught.exception, error)
            self.assertEqual(read.call_count, 5)
            self.assertEqual([call.args[0] for call in sleep.call_args_list], [0.02, 0.04, 0.06, 0.08])

    def test_corrupt_status_is_not_retried(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "status.json").write_text('invalid', encoding='utf-8')
            with patch("service.storage.time.sleep") as sleep:
                with self.assertRaises(json.JSONDecodeError):
                    read_status(directory)
            sleep.assert_not_called()

    def test_missing_status_stays_not_found_without_retry(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch("service.storage.time.sleep") as sleep:
                with self.assertRaises(HTTPException) as caught:
                    read_status(Path(temporary))
            self.assertEqual(caught.exception.status_code, 404)
            sleep.assert_not_called()

    def test_retries_transient_windows_replace_denial(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            attempts = 0

            def replace(source: Path, target: Path):
                nonlocal attempts
                attempts += 1
                if attempts < 3:
                    raise PermissionError(5, "Access is denied")
                os.replace(source, target)

            with patch.object(Path, "replace", autospec=True, side_effect=replace), \
                 patch("service.storage.time.sleep") as sleep:
                write_status(directory, {"status": "ready"})

            self.assertEqual(attempts, 3)
            self.assertEqual(sleep.call_count, 2)
            self.assertEqual(read_status(directory)["status"], "ready")
            self.assertEqual(list(directory.glob("status.json.*.tmp")), [])

    def test_cleans_unique_temporary_file_after_persistent_denial(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with patch.object(Path, "replace", autospec=True, side_effect=PermissionError(5, "Access is denied")), \
                 patch("service.storage.time.sleep"):
                with self.assertRaises(PermissionError):
                    write_status(directory, {"status": "ready"})

            self.assertFalse((directory / "status.json").exists())
            self.assertEqual(list(directory.glob("status.json.*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
