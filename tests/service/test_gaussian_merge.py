import struct
import math
import tempfile
import unittest
from pathlib import Path

from service.gaussian_merge import merge_level, read_layout, validate_regions


def sample(path, offset, points, geo=True):
    header = ("ply\nformat binary_little_endian 1.0\n"
              + ("comment epsg 32650\n"
                 f"comment offsetx {offset[0]}\ncomment offsety {offset[1]}\ncomment offsetz {offset[2]}\n" if geo else "") +
              f"element vertex {len(points)}\n"
              "property float x\nproperty float y\nproperty float z\n"
              "property float scale_0\nproperty float scale_1\nproperty float scale_2\n"
              "property float opacity\n"
              "property float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\n"
              "property float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\nend_header\n")
    with path.open("wb") as output:
        output.write(header.encode("ascii"))
        for point in points:
            output.write(struct.pack("<14f", *point, 1, 1, 1, 0.5, 0, 0, 0, 1, 0, 0, 0))


class GaussianMergeTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_merge_offsets_regions_and_attributes(self):
        first, second, result = (self.root / name for name in ("first.ply", "second.ply", "merged.ply"))
        sample(first, (1000, 2000, 10), [(0, 0, 0), (5, 0, 0)])
        sample(second, (1004, 2000, 10), [(0, 0, 0), (5, 0, 0)])
        region = {"kind": "keep", "model": 0,
                  "polygon": [[-1, -1], [6, -1], [6, 1], [-1, 1]]}
        summary = merge_level([first, second], result, [region])
        self.assertEqual(summary["count"], 3)
        self.assertEqual(summary["by_model"], [2, 1])
        layout = read_layout(result)
        self.assertEqual(layout.offset, (1000, 2000, 10))
        self.assertEqual(layout.count, 3)
        with result.open("rb") as source:
            source.seek(layout.data_start)
            rows = [struct.unpack("<14f", source.read(56)) for _ in range(3)]
        self.assertEqual([row[0] for row in rows], [0, 5, 9])
        self.assertTrue(all(row[6] == 0.5 for row in rows))

    def test_conflicting_regions_stop_merge(self):
        source, result = self.root / "source.ply", self.root / "result.ply"
        sample(source, (1, 2, 3), [(0, 0, 0)])
        polygon = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
        with self.assertRaisesRegex(ValueError, "冲突"):
            merge_level([source, source], result, [
                {"kind": "keep", "model": 0, "polygon": polygon},
                {"kind": "keep", "model": 1, "polygon": polygon},
            ])
        self.assertFalse(result.exists())

    def test_target_model_changes_output_origin_without_rebinding_region(self):
        first, second, result = (self.root / name for name in ("first.ply", "second.ply", "merged.ply"))
        sample(first, (1000, 2000, 10), [(0, 0, 0)])
        sample(second, (1004, 2000, 10), [(0, 0, 0)])
        region = {"kind": "remove", "model": 1,
                  "polygon": [[-1, -1], [1, -1], [1, 1], [-1, 1]]}
        summary = merge_level([first, second], result, [region], target_model=1)
        self.assertEqual(summary["by_model"], [1, 0])
        layout = read_layout(result)
        self.assertEqual(layout.offset, (1004, 2000, 10))
        with result.open("rb") as source:
            source.seek(layout.data_start)
            self.assertEqual(struct.unpack("<3f", source.read(12)), (-4, 0, 0))

    def test_y_up_axis_maps_north_to_negative_z(self):
        first, second, result = (self.root / name for name in ("one.ply", "two.ply", "merged.ply"))
        sample(first, (1000, 2000, 10), [(0, 0, 0)])
        sample(second, (1000, 2005, 10), [(0, 0, 0)])
        summary = merge_level([first, second], result, [], axes=(1, -3, 2))
        self.assertEqual(summary["count"], 2)
        with result.open("rb") as source:
            source.seek(read_layout(result).data_start + 56)
            self.assertEqual(struct.unpack("<3f", source.read(12)), (0, 0, -5))

    def test_geographic_alignment_precedes_manual_correction(self):
        first, second, result = (self.root / name for name in ("first.ply", "second.ply", "merged.ply"))
        sample(first, (1000, 2000, 10), [(0, 0, 0)])
        sample(second, (1004, 2002, 13), [(0, 0, 0)])
        merge_level([first, second], result, [], correction=[(0, 0, 0), (1, -2, 5)])
        layout = read_layout(result)
        with result.open("rb") as source:
            source.seek(layout.data_start + layout.stride)
            self.assertEqual(struct.unpack("<3f", source.read(12)), (5, 0, 8))

    def test_region_clips_source_after_geographic_and_manual_translation(self):
        first, second, result = (self.root / name for name in ("first.ply", "second.ply", "merged.ply"))
        sample(first, (1000, 2000, 10), [(0, 0, 0)])
        sample(second, (1004, 2000, 10), [(0, 0, 0), (2, 0, 0)])
        region = {"kind": "per_model", "actions": ["none", "remove_inside"],
                  "polygon": [[6.5, -1], [7.5, -1], [7.5, 1], [6.5, 1]]}
        summary = merge_level([first, second], result, [region],
                              correction=[(0, 0, 0), (3, 0, 0)])
        self.assertEqual(summary["by_model"], [1, 1])
        layout = read_layout(result)
        with result.open("rb") as source:
            source.seek(layout.data_start)
            self.assertEqual([struct.unpack("<f", source.read(56)[:4])[0] for _ in range(2)], [0, 9])

    def test_rotation_changes_clipping_position_and_gaussian_orientation(self):
        first, second, result = (self.root / name for name in ("first.ply", "second.ply", "merged.ply"))
        sample(first, (1000, 2000, 10), [(0, 0, 0)])
        sample(second, (1004, 2000, 10), [(1, 0, 0), (2, 0, 0)])
        half = math.sqrt(0.5)
        region = {"kind": "per_model", "actions": ["none", "remove_inside"],
                  "polygon": [[3.5, 0.5], [4.5, 0.5], [4.5, 1.5], [3.5, 1.5]]}
        summary = merge_level([first, second], result, [region],
                              rotations=[(1, 0, 0, 0), (half, 0, 0, half)])
        self.assertEqual(summary["by_model"], [1, 1])
        layout = read_layout(result)
        with result.open("rb") as source:
            source.seek(layout.data_start + layout.stride)
            row = struct.unpack("<14f", source.read(layout.stride))
        self.assertAlmostEqual(row[0], 4)
        self.assertAlmostEqual(row[1], 2)
        self.assertAlmostEqual(row[10], half)
        self.assertAlmostEqual(row[13], half)

    def test_rotation_respects_y_up_file_axes(self):
        first, second, result = (self.root / name for name in ("first.ply", "second.ply", "merged.ply"))
        sample(first, (1000, 2000, 10), [(0, 0, 0)])
        sample(second, (1000, 2000, 10), [(1, 0, 0)])
        half = math.sqrt(0.5)
        merge_level([first, second], result, [], axes=(1, -3, 2),
                    rotations=[(1, 0, 0, 0), (half, 0, 0, half)])
        layout = read_layout(result)
        with result.open("rb") as source:
            source.seek(layout.data_start + layout.stride)
            row = struct.unpack("<14f", source.read(layout.stride))
        self.assertAlmostEqual(row[0], 0)
        self.assertAlmostEqual(row[2], -1)
        self.assertAlmostEqual(row[12], half)

    def test_each_model_rules_export_in_target_axis_units_and_gaussian_shape(self):
        target, source, result = (self.root / name for name in ("target.ply", "source.ply", "merged.ply"))
        sample(target, (1000, 2000, 10), [(0, 0, 0)])
        sample(source, (1000, 2000, 10), [(1, 2, 3)])
        models = [
            {"epsg": "32650", "offset": [1000, 2000, 10], "axes": [1, -3, 2],
             "unit": "cm", "scale": 2.0},
            {"epsg": "32650", "offset": [1000, 2000, 10], "axes": [1, 2, 3],
             "unit": "m", "scale": 1.0},
        ]
        merge_level([target, source], result, [], coordinates=models)
        layout = read_layout(result)
        with result.open("rb") as data:
            data.seek(layout.data_start + layout.stride)
            row = struct.unpack("<14f", data.read(layout.stride))
        self.assertAlmostEqual(row[0], 50)
        self.assertAlmostEqual(row[1], 150)
        self.assertAlmostEqual(row[2], -100)
        self.assertAlmostEqual(row[3], 1 + math.log(50), places=6)
        self.assertAlmostEqual(row[10], math.sqrt(0.5))
        self.assertAlmostEqual(row[11], -math.sqrt(0.5))

        region = {"kind": "per_model", "actions": ["none", "remove_inside"],
                  "polygon": [[0.5, 1.5], [1.5, 1.5], [1.5, 2.5], [0.5, 2.5]]}
        self.assertEqual(merge_level([target, source], result, [region], coordinates=models)["by_model"], [1, 0])

    def test_unknown_target_origin_stays_absent_in_output(self):
        first, second, result = (self.root / name for name in ("first.ply", "second.ply", "merged.ply"))
        sample(first, (0, 0, 0), [(0, 0, 0)], geo=False)
        sample(second, (1004, 2000, 10), [(0, 0, 0)])
        summary = merge_level([first, second], result, [], correction=[(0, 0, 0), (3, 0, 0)],
                              coordinates=[{"epsg": "", "offset": None},
                                           {"epsg": "32650", "offset": [1004, 2000, 10]}])
        self.assertIsNone(summary["offset"])
        layout = read_layout(result)
        self.assertEqual(layout.epsg, "")
        self.assertFalse(any(line.startswith("comment offset") for line in layout.header))
        with result.open("rb") as source:
            source.seek(layout.data_start + layout.stride)
            self.assertEqual(struct.unpack("<3f", source.read(12)), (3, 0, 0))

    def test_conflicting_keep_polygons_are_rejected_before_reading_points(self):
        with self.assertRaisesRegex(ValueError, "冲突"):
            validate_regions([
                {"kind": "keep", "model": 0, "polygon": [[0, 0], [2, 0], [2, 2], [0, 2]]},
                {"kind": "keep", "model": 1, "polygon": [[1, 1], [3, 1], [3, 3], [1, 3]]},
            ], 2)

    def test_clip_regions_select_models_and_invert_boundary(self):
        first, second, result = (self.root / name for name in ("one.ply", "two.ply", "result.ply"))
        sample(first, (0, 0, 0), [(-2, 0, 0), (0, 0, 0), (2, 0, 0)])
        sample(second, (0, 0, 0), [(-2, 0, 0), (0, 0, 0), (2, 0, 0)])
        polygon = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
        summary = merge_level([first, second], result, [
            {"kind": "clip", "models": [0], "side": "inside", "polygon": polygon},
            {"kind": "clip", "models": [1], "side": "outside", "polygon": polygon},
        ])
        self.assertEqual(summary["by_model"], [1, 2])

    def test_clip_regions_reject_empty_model_selection(self):
        with self.assertRaisesRegex(ValueError, "作用模型"):
            validate_regions([{"kind": "clip", "models": [], "side": "inside",
                               "polygon": [[0, 0], [1, 0], [0, 1]]}], 2)

    def test_select_region_keeps_only_chosen_models_on_selected_side(self):
        first, second, result = (self.root / name for name in ("one.ply", "two.ply", "result.ply"))
        sample(first, (0, 0, 0), [(0, 0, 0), (2, 0, 0)])
        sample(second, (0, 0, 0), [(0, 0, 0), (2, 0, 0)])
        polygon = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
        summary = merge_level([first, second], result, [
            {"kind": "select", "models": [0], "side": "inside", "polygon": polygon},
        ])
        self.assertEqual(summary["by_model"], [2, 1])

    def test_one_boundary_can_delete_opposite_sides_for_two_models(self):
        first, second, result = (self.root / name for name in ("one.ply", "two.ply", "result.ply"))
        sample(first, (0, 0, 0), [(0, 0, 0), (2, 0, 0)])
        sample(second, (0, 0, 0), [(0, 0, 0), (2, 0, 0)])
        polygon = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
        summary = merge_level([first, second], result, [{"kind": "per_model",
            "actions": ["remove_inside", "remove_outside"], "polygon": polygon}])
        self.assertEqual(summary["by_model"], [1, 1])
        with result.open("rb") as source:
            source.seek(read_layout(result).data_start)
            self.assertEqual([struct.unpack("<f", source.read(56)[:4])[0] for _ in range(2)], [2, 0])

    def test_overlapping_boundaries_apply_independently_without_owner_conflict(self):
        source, result = self.root / "one.ply", self.root / "result.ply"
        sample(source, (0, 0, 0), [(0, 0, 0), (2, 0, 0)])
        polygon = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
        regions = [
            {"kind": "per_model", "actions": ["remove_inside", "none"], "polygon": polygon},
            {"kind": "per_model", "actions": ["none", "remove_outside"], "polygon": polygon},
        ]
        self.assertEqual(merge_level([source, source], result, regions)["by_model"], [1, 1])

    def test_per_model_actions_must_match_model_count(self):
        with self.assertRaisesRegex(ValueError, "逐模型"):
            validate_regions([{"kind": "per_model", "actions": ["remove_inside"],
                               "polygon": [[0, 0], [1, 0], [0, 1]]}], 2)
