import tempfile
import unittest
import json
from pathlib import Path
from service.ply_coordinates import read_model_coordinates, read_ply_coordinates


class PlyCoordinateTests(unittest.TestCase):
    def read(self, data, name="model.ply"):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / name
            path.write_bytes(data)
            return read_ply_coordinates(path)

    def test_binary_header_preserves_offset_text_without_reading_vertices(self):
        result = self.read(b"ply\r\nformat binary_little_endian 1.0\r\n"
            b"comment source L2Pro\r\ncomment epsg 32651\r\n"
            b"comment offsetx 260137.0225660622527357\r\n"
            b"comment offsety 3314437.5482058529742062\r\n"
            b"comment offsetz 22.7376999994739890\r\n"
            b"comment shiftx 0\r\ncomment scalex 1\r\nend_header\r\n\xff\x00")
        self.assertEqual(result["epsg"], "32651")
        self.assertEqual(result["source"], "L2Pro")
        self.assertEqual(result["offset"], ["260137.0225660622527357", "3314437.5482058529742062", "22.7376999994739890"])
        self.assertNotIn("height_datum", result)

    def test_missing_or_invalid_fields_are_not_assumed_zero(self):
        result = self.read(b"ply\ncomment epsg invalid\ncomment offsetx nan\ncomment offsety inf\ncomment offsetz nope\nend_header\n")
        self.assertEqual(result["epsg"], "")
        self.assertEqual(result["offset"], [None, None, None])

    def test_missing_header_oversized_header_and_non_ply(self):
        for data, name in ((b"ply\ncomment epsg 32651\n", "model.ply"),
                           (b"ply\n" + b"a" * (1024 * 1024) + b"\nend_header\n", "model.ply"),
                           (b"ply\ncomment epsg 32651\nend_header\n", "model.sog")):
            self.assertEqual(self.read(data, name)["epsg"], "")

    def test_lcc_geographic_hints_use_reader_axis_transform(self):
        with tempfile.TemporaryDirectory() as directory:
            for suffix in ("lcc", "lcc2"):
                path = Path(directory) / f"scene.{suffix}"
                path.write_text(json.dumps({"epsg": 32650, "offset": [788279.625, 3152314.25, 64.2993],
                                            "shift": [0, 0, 0], "scale": [1, 1, 1], "dataType": "L2Pro"}),
                                encoding="utf-8")
                hints = read_model_coordinates(path)
                self.assertEqual(hints["epsg"], "32650")
                self.assertEqual(hints["offset"], ["788279.625", "3152314.25", "64.2993"])
                self.assertEqual(hints["axes"], [-1, 3, 2])

    def test_lcc_result_does_not_claim_converted_ply_has_source_axes(self):
        from service.routes.gaussian_editor import output_coordinate_comments
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "converted.ply"
            self.assertEqual(output_coordinate_comments(source, None, True, "lcc2"), ("manifest", None))
