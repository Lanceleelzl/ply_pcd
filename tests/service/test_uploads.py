import io
import tempfile
import unittest
import zipfile
from pathlib import Path

from fastapi import UploadFile

from service.dataset_formats import DatasetFormatError
from service.uploads import save_upload_directory_with_sha256


class DirectoryUploadTest(unittest.IsolatedAsyncioTestCase):
    async def test_preserves_relative_paths_in_zip(self):
        files = [
            UploadFile(filename="scene/lod-meta.json", file=io.BytesIO(b"meta")),
            UploadFile(filename="scene/0_0/means.webp", file=io.BytesIO(b"means")),
        ]
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "dataset.zip"
            size, digest = await save_upload_directory_with_sha256(files, destination)
            self.assertEqual(size, 9)
            self.assertEqual(len(digest), 64)
            with zipfile.ZipFile(destination) as archive:
                self.assertEqual(archive.namelist(), ["scene/lod-meta.json", "scene/0_0/means.webp"])

    async def test_rejects_unsafe_relative_path(self):
        files = [UploadFile(filename="../meta.json", file=io.BytesIO(b"{}"))]
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(DatasetFormatError, "Unsafe"):
                await save_upload_directory_with_sha256(files, Path(temporary) / "dataset.zip")


if __name__ == "__main__":
    unittest.main()
