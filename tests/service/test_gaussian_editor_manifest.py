import unittest
import hashlib
import io
import json
import zipfile

from service.routes.gaussian_editor import geography_from_result_manifest, geography_from_streamed_archive


class EditorCoordinateManifestTests(unittest.TestCase):
    def setUp(self):
        self.manifest = {
            "result_format": "sog", "result_gaussians": 1458,
            "result_file_bytes": 31193, "result_file_sha256": "a" * 64,
            "coordinate_mode": "source",
            "result_ply_coordinate_hints": {
                "epsg": "32651", "offset": ["264782.73", "3393689.11", "13.9865"],
                "shift": ["0", "0", "0"], "scale": ["1", "1", "1"],
            },
        }

    def test_matching_file_restores_projected_origin(self):
        geography = geography_from_result_manifest(self.manifest, "a" * 64, "sog", 1458, 31193)
        self.assertEqual(geography["source_epsg"], 32651)
        self.assertEqual(geography["projected_origin"], [264782.73, 3393689.11, 13.9865])
        self.assertEqual(geography["axes"], [1, 2, 3])

    def test_rejects_wrong_file_and_ambiguous_frame(self):
        with self.assertRaisesRegex(ValueError, "重新下载"):
            geography_from_result_manifest(
                {key: value for key, value in self.manifest.items() if key != "result_file_sha256"},
                "a" * 64, "sog", 1458, 31193)
        for digest, format_name, count, size in [
            ("b" * 64, "sog", 1458, 31193),
            ("a" * 64, "compressed_ply", 1458, 31193),
            ("a" * 64, "sog", 1457, 31193),
            ("a" * 64, "sog", 1458, 31194),
        ]:
            with self.subTest(digest=digest, format_name=format_name, count=count, size=size):
                with self.assertRaisesRegex(ValueError, "不一致"):
                    geography_from_result_manifest(self.manifest, digest, format_name, count, size)
        for change in [
            {"coordinate_mode": "manifest"},
            {"result_ply_coordinate_hints": {**self.manifest["result_ply_coordinate_hints"],
                                               "shift": ["1", "0", "0"]}},
            {"result_ply_coordinate_hints": {**self.manifest["result_ply_coordinate_hints"],
                                               "epsg": "4326"}},
        ]:
            with self.subTest(change=change):
                with self.assertRaises(ValueError):
                    geography_from_result_manifest({**self.manifest, **change}, "a" * 64, "sog", 1458, 31193)


class StreamedCoordinateManifestTests(unittest.TestCase):
    def archive(self, *, count=2, offset="264782.73", tamper=None, sidecar=True, prefix=""):
        metadata = {"lodLevels": 1, "tree": {"lods": {"0": {"count": 2}}}}
        manifest = {"schema_version": 1, "result_format": "streamed_sog", "levels": [{
            "streamed_lod": 0, "source_lod": 6, "result_gaussians": count,
            "coordinate_mode": "embedded", "result_ply_coordinate_hints": {
                "epsg": "32651", "offset": [offset, "3393689.11", "13.9865"],
                "shift": ["0", "0", "0"], "scale": ["1", "1", "1"],
            },
        }]}
        files = {"lod-meta.json": json.dumps(metadata).encode(), "chunk.bin": b"source data"}
        if sidecar:
            files["coordinate-manifest.json"] = json.dumps(manifest).encode()
        entries = [{"path": name, "bytes": len(value), "sha256": hashlib.sha256(value).hexdigest()}
                   for name, value in files.items()]
        if tamper:
            files[tamper] += b"changed"
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            for name, value in files.items():
                archive.writestr(prefix + name, value)
            archive.writestr(prefix + "cache-manifest.json", json.dumps({"files": entries}))
        buffer.seek(0)
        return buffer

    def test_restores_checked_streamed_origin(self):
        geography = geography_from_streamed_archive(self.archive(), "lod-meta.json")
        self.assertEqual(geography["source_epsg"], 32651)
        self.assertEqual(geography["projected_origin"], [264782.73, 3393689.11, 13.9865])
        self.assertEqual(geography_from_streamed_archive(self.archive(prefix="model/"), "model/lod-meta.json"), geography)
        self.assertIsNone(geography_from_streamed_archive(self.archive(sidecar=False), "lod-meta.json"))

    def test_rejects_changed_resource_and_wrong_layer_count(self):
        for archive in (self.archive(tamper="chunk.bin"), self.archive(tamper="coordinate-manifest.json"),
                        self.archive(count=3)):
            with self.assertRaises(ValueError):
                geography_from_streamed_archive(archive, "lod-meta.json")


if __name__ == "__main__":
    unittest.main()
