import tempfile
import unittest
from pathlib import Path

from service.gaussian_editor_rules import clip_ply, contains, validate_rules
from service.gaussian_merge import read_layout


class EditorPolygonTests(unittest.TestCase):
    def rule(self, points):
        return {"type": "polygon", "action": "keep", "points": points}

    def test_small_polygon_at_projected_origin_is_valid_in_both_windings(self):
        points = [[500000, 3000000], [500000.001, 3000000],
                  [500000.001, 3000000.001], [500000, 3000000.001]]
        for winding in (points, points[::-1]):
            rule = self.rule(winding)
            validate_rules([rule])
            self.assertTrue(contains(rule, (500000.0005, 3000000.0005, 100)))
            self.assertFalse(contains(rule, (500000.002, 3000000.0005, 0)))

    def test_rejects_repeated_vertices_touches_and_overlapping_edges(self):
        cases = [
            [[0, 0], [4, 0], [4, 0], [4, 4], [0, 4]],
            [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
            [[0, 0], [4, 0], [4, 4], [2, 0], [0, 4]],
            [[0, 0], [4, 0], [2, 0], [4, 4], [0, 4]],
            [[0, 0], [4, 0], [4, 4], [1, 4], [1, 0], [3, 0], [3, 2], [0, 2]],
        ]
        for points in cases:
            with self.subTest(points=points), self.assertRaises(ValueError):
                validate_rules([self.rule(points)])

    def test_allows_collinear_inserted_vertex_and_concave_polygon(self):
        for points in (
            [[0, 0], [2, 0], [4, 0], [4, 4], [0, 4]],
            [[0, 0], [4, 0], [4, 4], [2, 2], [0, 4]],
        ):
            validate_rules([self.rule(points)])

    def test_small_projected_polygon_clips_boundary_points_without_changing_payload(self):
        source = Path(__file__).parent / "gaussian-small-binary.ply"
        layout = read_layout(source)
        data = source.read_bytes()[layout.data_start:]
        rule = self.rule([[500000, 3000000], [500000.001, 3000000],
                          [500000.001, 3000000.001], [500000, 3000000.001]])
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "clipped.ply"
            count = clip_ply(source, destination, [rule], to_common=lambda point:
                             (point[0] + 500000, point[1] + 3000000, point[2]))
            result = read_layout(destination)
            self.assertEqual(count, 2)
            self.assertEqual(result.count, 2)
            self.assertEqual(destination.read_bytes()[result.data_start:],
                             data[:layout.stride] + data[3 * layout.stride:4 * layout.stride])


if __name__ == "__main__":
    unittest.main()
