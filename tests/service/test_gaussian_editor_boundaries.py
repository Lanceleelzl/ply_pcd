import math
import unittest

from service.gaussian_editor_rules import contains, keeps_point


class EditorBoxBoundaryTests(unittest.TestCase):
    def box(self, scale=1, action="keep"):
        return {"type": "box", "action": action, "center": [0, 0, 0],
                "size": [2 * scale, scale, scale],
                "rotation": [math.sqrt(.5), 0, 0, math.sqrt(.5)]}

    def test_rotated_faces_edges_and_corners_are_included_across_scales(self):
        for scale in (1e-6, 1, 1e6):
            box = self.box(scale)
            for point in ((0, 1, 0), (.5, 0, 0), (0, 0, .5), (.5, 1, .5)):
                with self.subTest(scale=scale, point=point):
                    self.assertTrue(contains(box, tuple(value * scale for value in point)))

    def test_roundoff_tolerance_does_not_include_true_outside_points(self):
        for scale in (1e-6, 1, 1e6):
            for point in ((0, 1 + 1e-10, 0), (.5 + 1e-10, 0, 0), (0, 0, .5 + 1e-10)):
                with self.subTest(scale=scale, point=point):
                    self.assertFalse(contains(self.box(scale), tuple(value * scale for value in point)))

    def test_remove_rules_also_include_the_surface(self):
        self.assertTrue(keeps_point([self.box()], (0, 1, 0)))
        self.assertFalse(keeps_point([self.box(action="remove")], (0, 1, 0)))


if __name__ == "__main__":
    unittest.main()
