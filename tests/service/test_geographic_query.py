import unittest
from pydantic import ValidationError
from service.geographic_query import GeographicQuery, GeographicOrigin, project_origin, query_coordinates


class GeographicQueryTests(unittest.TestCase):
    def request(self, **changes):
        values = dict(point=(12, 3.5, -7), axes=(1, -3, 2), reference=(0, 0, 0),
                      independent_origin=(100, 200, 300), projected_origin=(500000, 0, 50),
                      metres_per_unit=1, source_epsg=32651)
        return GeographicQuery(**(values | changes))

    def test_planner_axis_mapping_height_and_independent_origin(self):
        result = query_coordinates(self.request())
        self.assertEqual(result['independent'], [112, 207, 303.5])
        self.assertEqual(result['projected'], [500012, 7, 53.5])
        self.assertGreater(result['longitude'], 123)
        self.assertGreater(result['latitude'], 0)

    def test_reference_point_and_centimetres(self):
        result = query_coordinates(self.request(point=(110, 220, 330), reference=(100, 200, 300), metres_per_unit=.01))
        self.assertEqual(result['independent'], [100.1, 199.7, 300.2])

    def test_projected_reference_round_trip_wgs84(self):
        origin = project_origin(GeographicOrigin(source_epsg=32651, longitude=120.5, latitude=30))
        for target in (4326,):
            result = query_coordinates(self.request(point=(0, 0, 0),
                projected_origin=(origin['east'], origin['north'], 20), target_epsg=target))
            self.assertAlmostEqual(result['longitude'], 120.5, places=7)
            self.assertAlmostEqual(result['latitude'], 30, places=7)

    def test_cgcs2000_output_is_not_supported(self):
        with self.assertRaises(ValidationError):
            self.request(target_epsg=4490)

    def test_origin_returns_projected_unit_factors_for_reverse_query(self):
        origin = project_origin(GeographicOrigin(source_epsg=32651, longitude=120.5, latitude=30))
        self.assertEqual(origin['metres_per_projected_unit'], [1, 1])
        feet = project_origin(GeographicOrigin(source_epsg=2277, longitude=-97.7, latitude=30.3))
        for factor in feet['metres_per_projected_unit']:
            self.assertAlmostEqual(factor, 1200 / 3937)

    def test_user_ply_offset_recovers_projection_and_height(self):
        result = query_coordinates(self.request(point=(10, 20, 3), axes=(1, 2, 3),
            projected_origin=(260137.02256606225, 3314437.548205853, 22.737699999474)))
        self.assertAlmostEqual(result['projected'][0], 260147.02256606225)
        self.assertAlmostEqual(result['projected'][1], 3314457.548205853)
        self.assertAlmostEqual(result['projected'][2], 25.737699999474)
        self.assertGreater(result['longitude'], 120.514979273)
        self.assertGreater(result['latitude'], 29.937326246)

    def test_invalid_axes_units_and_nonfinite_points(self):
        for changes in (dict(axes=(1, -1, 3)), dict(metres_per_unit=0), dict(point=(float('nan'), 0, 0))):
            with self.assertRaises(ValidationError):
                self.request(**changes)

    def test_invalid_or_geographic_source_epsg(self):
        for epsg in (4326, 999999):
            with self.assertRaises(Exception):
                query_coordinates(self.request(source_epsg=epsg))

if __name__ == '__main__':
    unittest.main()
