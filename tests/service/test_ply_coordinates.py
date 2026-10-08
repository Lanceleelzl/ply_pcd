import tempfile
import unittest
from pathlib import Path
from service.ply_coordinates import read_ply_coordinates


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
