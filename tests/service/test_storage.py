import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from service.storage import read_status, write_status


class StatusStorageTest(unittest.TestCase):
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
