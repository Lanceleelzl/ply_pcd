import tempfile
import unittest
import json
import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from fastapi import HTTPException
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

    def test_editor_lod_frame_compares_all_header_coordinate_fields(self):
        from service.routes.gaussian_editor import lod_coordinate_frame
        original = {"epsg": "32651", "offset": ["264782.73", "3393689.11", "13.98"],
                    "shift": ["0", "0", "0"], "scale": ["1", "1", "1"]}
        equivalent = {**original, "offset": ["264782.7300", "3393689.110", "13.980"],
                      "shift": ["0.0", "0", "0"], "scale": ["1.000", "1", "1"]}
        self.assertEqual(lod_coordinate_frame(original), lod_coordinate_frame(equivalent))
        for key, value in (("epsg", "32650"), ("offset", [None, *original["offset"][1:]]),
                           ("shift", ["1", "0", "0"]), ("scale", ["2", "1", "1"])):
            changed = {**original, key: value}
            self.assertNotEqual(lod_coordinate_frame(original), lod_coordinate_frame(changed))

    def test_editor_rejects_mismatched_lod_frames_before_processing(self):
        from service.routes.gaussian_editor import ProcessRequest, create_editor_router
        status = {"status": "ready", "input_kind": "lod_group", "lods": [
            {"level": 0, "path": "input/lod-0.ply"}, {"level": 1, "path": "input/lod-1.ply"}]}
        tasks = SimpleNamespace(read=lambda _task_id: (Path("unused"), status), running={},
                                levels=lambda _status, _directory: [0, 1])
        process = next(route.endpoint for route in create_editor_router(tasks).routes
                       if route.path.endswith("/{task_id}/process"))
        first = {"epsg": "32651", "offset": ["1", "2", "3"],
                 "shift": ["0", "0", "0"], "scale": ["1", "1", "1"]}
        second = {**first, "scale": ["2", "1", "1"]}
        with patch("service.routes.gaussian_editor.read_ply_coordinates", side_effect=[first, second]):
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(process("task", ProcessRequest(levels=[0, 1])))
        self.assertEqual(caught.exception.status_code, 422)
        self.assertNotIn("process_status", status)
