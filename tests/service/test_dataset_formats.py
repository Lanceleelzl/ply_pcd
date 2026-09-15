import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from service.dataset_formats import DatasetFormatError, probe_dataset


class DatasetFormatsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, name: str, content: bytes) -> Path:
        path = self.root / name
        path.write_bytes(content)
        return path

    def archive(self, name: str, entries: dict[str, bytes]) -> Path:
        path = self.root / name
        with zipfile.ZipFile(path, "w") as archive:
            for entry, content in entries.items():
                archive.writestr(entry, content)
        return path

    def test_distinguishes_plain_gaussian_and_compressed_ply(self):
        plain = self.write("plain.ply", b"ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n")
        gaussian = self.write("gaussian.ply", b"ply\nformat binary_little_endian 1.0\nelement vertex 0\nproperty float x\nproperty float y\nproperty float z\nproperty float scale_0\nproperty float scale_1\nproperty float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\nproperty float opacity\nend_header\n")
        compressed = self.write("compressed.ply", b"ply\nformat binary_little_endian 1.0\nelement chunk 1\nproperty float min_x\nelement vertex 0\nproperty uint packed_position\nend_header\n")
        self.assertEqual(probe_dataset(plain).format, "ply")
        self.assertEqual(probe_dataset(gaussian).format, "gaussian_ply")
        self.assertTrue(probe_dataset(gaussian).gaussian_capable)
        self.assertFalse(probe_dataset(plain).gaussian_capable)
        self.assertEqual(probe_dataset(compressed).format, "compressed_ply")

    def test_probes_bundled_sog_and_checks_references(self):
        metadata = {"version": 2, "means": {"files": ["means.webp"]}, "scales": {"files": ["scales.webp"]}}
        path = self.archive("scene.sog", {"meta.json": json.dumps(metadata).encode(), "means.webp": b"m", "scales.webp": b"s"})
        result = probe_dataset(path)
        self.assertEqual((result.format, result.container, result.version), ("sog", "sog", 2))
        broken = self.archive("broken.sog", {"meta.json": json.dumps(metadata).encode()})
        with self.assertRaisesRegex(DatasetFormatError, "missing referenced"):
            probe_dataset(broken)

    def test_probes_streamed_sog_with_common_root(self):
        lod = {"version": 1, "filenames": ["0_0/meta.json"]}
        path = self.archive("scene.zip", {
            "scene/lod-meta.json": json.dumps(lod).encode(),
            "scene/0_0/meta.json": json.dumps({"version": 2}).encode(),
        })
        result = probe_dataset(path)
        self.assertEqual(result.format, "streamed_sog")
        self.assertEqual(result.entrypoint, "scene/lod-meta.json")
        self.assertTrue(result.streaming_capable)

    def test_probes_lcc_and_rejects_incomplete_dataset(self):
        metadata = json.dumps({"version": "5.0", "fileType": "Portable"}).encode()
        valid = self.archive("scene.zip", {"meta.lcc": metadata, "Index.bin": b"i", "Data.bin": b"d"})
        self.assertEqual(probe_dataset(valid).format, "lcc")
        invalid = self.archive("broken.zip", {"meta.lcc": metadata, "Data.bin": b"d"})
        with self.assertRaisesRegex(DatasetFormatError, "index.bin"):
            probe_dataset(invalid)

        quality = self.archive("quality.zip", {
            "meta.lcc": json.dumps({"version": "5.0", "fileType": "Quality"}).encode(),
            "Index.bin": b"i", "Data.bin": b"d",
        })
        with self.assertRaisesRegex(DatasetFormatError, "Shcoef.bin"):
            probe_dataset(quality)

    def test_probes_lcc2_and_requires_declared_chunks(self):
        metadata = {
            "version": "0.0.3", "totalLevels": 1, "totalSplats": 1,
            "lodSplats": [1], "splatType": ".sog",
            "root": {"splatFiles": ["data/3dgs/0.sog"]},
        }
        valid = self.archive("scene.zip", {
            "scene.lcc2": json.dumps(metadata).encode(), "data/3dgs/0.sog": b"chunk",
        })
        self.assertEqual(probe_dataset(valid).format, "lcc2")
        missing = self.archive("missing.zip", {"scene.lcc2": json.dumps(metadata).encode()})
        with self.assertRaisesRegex(DatasetFormatError, "missing referenced"):
            probe_dataset(missing)

        unsupported = {**metadata, "splatType": ".ksplat"}
        invalid_type = self.archive("invalid-type.zip", {
            "scene.lcc2": json.dumps(unsupported).encode(), "data/3dgs/0.sog": b"chunk",
        })
        with self.assertRaisesRegex(DatasetFormatError, "splatType"):
            probe_dataset(invalid_type)

    def test_rejects_unsafe_and_ambiguous_archives(self):
        unsafe = self.archive("unsafe.zip", {"../meta.json": b"{}"})
        with self.assertRaisesRegex(DatasetFormatError, "Unsafe"):
            probe_dataset(unsafe)
        ambiguous = self.archive("ambiguous.zip", {"meta.lcc": b"{}", "scene.lcc2": b"{}", "Index.bin": b"i", "Data.bin": b"d"})
        with self.assertRaisesRegex(DatasetFormatError, "multiple"):
            probe_dataset(ambiguous)
