# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import math
from typing import Any


def transform_matrix(value: dict[str, Any]) -> list[list[float]]:
    tx, ty, tz = value["translation"]
    rx, ry, rz = (math.radians(number) for number in value["rotation_degrees"])
    sx, sy, sz = value["scale"]
    cx, qx = math.cos(rx), math.sin(rx)
    cy, qy = math.cos(ry), math.sin(ry)
    cz, qz = math.cos(rz), math.sin(rz)
    return [
        [cz * cy * sx, (cz * qy * qx - qz * cx) * sy, (cz * qy * cx + qz * qx) * sz, tx],
        [qz * cy * sx, (qz * qy * qx + cz * cx) * sy, (qz * qy * cx - cz * qx) * sz, ty],
        [-qy * sx, cy * qx * sy, cy * cx * sz, tz],
        [0.0, 0.0, 0.0, 1.0],
    ]


def matmul(a: list[list[float]], b: list[list[float]]) -> list[list[float]]:
    return [[sum(a[row][k] * b[k][column] for k in range(4)) for column in range(4)] for row in range(4)]


def inverse_affine(matrix: list[list[float]]) -> list[list[float]]:
    a, b, c, _ = matrix[0]
    d, e, f, _ = matrix[1]
    g, h, i, _ = matrix[2]
    determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
    if abs(determinant) < 1e-15:
        raise ValueError("Business transform is not invertible")
    linear = [
        [(e * i - f * h) / determinant, (c * h - b * i) / determinant, (b * f - c * e) / determinant],
        [(f * g - d * i) / determinant, (a * i - c * g) / determinant, (c * d - a * f) / determinant],
        [(d * h - e * g) / determinant, (b * g - a * h) / determinant, (a * e - b * d) / determinant],
    ]
    translation = [matrix[row][3] for row in range(3)]
    return [
        [*row, -sum(row[k] * translation[k] for k in range(3))]
        for row in linear
    ] + [[0.0, 0.0, 0.0, 1.0]]


def business_transforms(status: dict[str, Any]) -> dict[str, Any]:
    default = {"translation": [0.0] * 3, "rotation_degrees": [0.0] * 3, "scale": [1.0] * 3}
    return status.get("business_transforms", {"a": default, "b": default})
