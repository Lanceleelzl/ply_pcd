import math
import unittest

from service import app as service


class BusinessTransformTest(unittest.TestCase):
    def test_trs_order_and_inverse(self) -> None:
        value = {"translation": [2.0, 3.0, 4.0], "rotation_degrees": [-90.0, 0.0, 0.0], "scale": [1.0, 2.0, 3.0]}
        matrix = service._transform_matrix(value)
        point = [1.0, 2.0, 3.0, 1.0]
        apply = lambda m, p: [sum(m[row][column] * p[column] for column in range(4)) for row in range(4)]
        transformed = apply(matrix, point)
        self.assertTrue(all(math.isclose(transformed[index], [3.0, 12.0, 0.0, 1.0][index], abs_tol=1e-12) for index in range(4)))
        restored = apply(service._inverse_affine(matrix), transformed)
        self.assertTrue(all(math.isclose(restored[index], [1.0, 2.0, 3.0, 1.0][index], abs_tol=1e-12) for index in range(4)))

    def test_business_composition(self) -> None:
        pa = service._transform_matrix({"translation": [0.0]*3, "rotation_degrees": [-90.0, 0.0, 0.0], "scale": [1.0]*3})
        identity = service._transform_matrix({"translation": [0.0]*3, "rotation_degrees": [0.0]*3, "scale": [1.0]*3})
        business_a_to_b = service._matmul(identity, service._matmul(identity, service._inverse_affine(pa)))
        self.assertEqual(business_a_to_b, service._inverse_affine(pa))

    def test_nonuniform_business_coordinates_round_trip(self) -> None:
        pa = service._transform_matrix({"translation": [500000, 4000000, 30], "rotation_degrees": [-90, 20, 15], "scale": [1, 2, 3]})
        pb = service._transform_matrix({"translation": [100, -20, 7], "rotation_degrees": [10, 0, 45], "scale": [2, 3, 1]})
        file_a_to_b = service._transform_matrix({"translation": [2, 4, -1], "rotation_degrees": [0, 0, 30], "scale": [1, 1, 1]})
        business_a_to_b = service._matmul(pb, service._matmul(file_a_to_b, service._inverse_affine(pa)))
        apply = lambda m, p: [sum(m[row][column] * p[column] for column in range(4)) for row in range(4)]
        point = [1, 2, 3, 1]
        business_a = apply(pa, point)
        actual = apply(business_a_to_b, business_a)
        expected = apply(pb, apply(file_a_to_b, point))
        self.assertTrue(all(abs(a-b) < 1e-8 for a, b in zip(actual, expected)))
        restored = apply(service._inverse_affine(business_a_to_b), actual)
        self.assertTrue(all(abs(a-b) < 1e-8 for a, b in zip(restored, business_a)))

    def test_invalid_parameters_are_rejected(self) -> None:
        for values in ({"translation": [1, 2]}, {"rotation_degrees": [float("nan"), 0, 0]}, {"scale": [0, 1, 1]}, {"scale": [-1, 1, 1]}):
            with self.subTest(values=values), self.assertRaises(service.HTTPException):
                service._validate_transform(service.TransformParameters(**values))


if __name__ == "__main__":
    unittest.main()
