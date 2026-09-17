import hashlib
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from service.streaming_zip import directory_zip_metadata, stream_directory_zip


class StreamingZipTest(unittest.TestCase):
    def test_stream_preserves_cache_tree_and_contents(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "lod-meta.json").write_text('{"type":"streamed-sog"}', encoding="utf-8")
            (root / "lod-0").mkdir()
            (root / "lod-0" / "chunk-0.sog").write_bytes(b"sog-data")

            payload = b"".join(stream_directory_zip(root))

        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            self.assertEqual(archive.testzip(), None)
            self.assertEqual(archive.namelist(), ["lod-0/chunk-0.sog", "lod-meta.json", "cache-manifest.json"])
            self.assertEqual(archive.read("lod-0/chunk-0.sog"), b"sog-data")
            self.assertEqual(archive.read("lod-meta.json"), b'{"type":"streamed-sog"}')
            manifest = json.loads(archive.read("cache-manifest.json"))
            self.assertEqual(manifest["schema_version"], 1)
            self.assertEqual(manifest["hash_algorithm"], "sha256")
            self.assertEqual(manifest["files"], [
                {"path": "lod-0/chunk-0.sog", "bytes": 8, "sha256": hashlib.sha256(b"sog-data").hexdigest()},
                {"path": "lod-meta.json", "bytes": 23, "sha256": hashlib.sha256(b'{"type":"streamed-sog"}').hexdigest()},
            ])

    def test_metadata_excludes_generated_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "chunk.sog").write_bytes(b"1234")
            (root / "cache-manifest.json").write_bytes(b"stale")
            self.assertEqual(directory_zip_metadata(root), (1, 4))


if __name__ == "__main__":
    unittest.main()
