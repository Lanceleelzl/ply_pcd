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


if __name__ == "__main__":
    unittest.main()
