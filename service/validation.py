# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import math
from pathlib import Path

from fastapi import HTTPException, UploadFile

from service.schemas import TransformParameters


def validate_transform(value: TransformParameters) -> None:
    fields = (
        ("translation", value.translation),
        ("rotation_degrees", value.rotation_degrees),
        ("scale", value.scale),
    )
    for name, values in fields:
        if len(values) != 3 or not all(math.isfinite(number) for number in values):
            raise HTTPException(status_code=400, detail=f"{name} must contain three finite numbers")
    if any(number <= 0 for number in value.scale):
        raise HTTPException(status_code=400, detail="scale values must be greater than zero")


def validate_registration_parameters(
    min_rms_decrease: float,
    sampling_limit: int,
    overlap: float,
    random_seed: int,
    precision_mode: str = "recommended",
) -> None:
    if not 1.0e-8 <= min_rms_decrease <= 1.0e-3:
        raise HTTPException(status_code=400, detail="min_rms_decrease must be between 1e-8 and 1e-3")
    if not 10000 <= sampling_limit <= 500000:
        raise HTTPException(status_code=400, detail="sampling_limit must be between 10000 and 500000")
    if not 0.5 <= overlap <= 1.0:
        raise HTTPException(status_code=400, detail="overlap must be between 0.5 and 1.0")
    if not 0 <= random_seed <= 4294967295:
        raise HTTPException(status_code=400, detail="Invalid registration parameters")
    if precision_mode not in {"recommended", "high_accuracy"}:
        raise HTTPException(status_code=400, detail="precision_mode must be recommended or high_accuracy")


def validate_initial_matrix(matrix: list[list[float]], field_name: str = "initial_pcd_to_ply") -> None:
    if len(matrix) != 4 or any(len(row) != 4 for row in matrix):
        raise HTTPException(status_code=400, detail=f"{field_name} must be a 4x4 matrix")
    if any(not isinstance(value, (int, float)) or not math.isfinite(value) for row in matrix for value in row):
        raise HTTPException(status_code=400, detail=f"{field_name} must contain only numbers")
    tolerance = 1.0e-5
    if any(abs(matrix[3][column] - (1.0 if column == 3 else 0.0)) > tolerance for column in range(4)):
        raise HTTPException(status_code=400, detail=f"{field_name} must have last row [0, 0, 0, 1]")
    for column in range(3):
        length_squared = sum(matrix[row][column] ** 2 for row in range(3))
        if abs(length_squared - 1.0) > tolerance:
            raise HTTPException(status_code=400, detail=f"{field_name} rotation must not contain scale")
    for left in range(3):
        for right in range(left + 1, 3):
            dot = sum(matrix[row][left] * matrix[row][right] for row in range(3))
            if abs(dot) > tolerance:
                raise HTTPException(status_code=400, detail=f"{field_name} rotation must be orthogonal")
    determinant = (
        matrix[0][0] * (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1])
        - matrix[0][1] * (matrix[1][0] * matrix[2][2] - matrix[1][2] * matrix[2][0])
        + matrix[0][2] * (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0])
    )
    if abs(determinant - 1.0) > tolerance:
        raise HTTPException(status_code=400, detail=f"{field_name} rotation determinant must be +1")


def reference_extension(upload: UploadFile) -> str:
    suffix = Path(upload.filename or "").suffix.lower()
    if suffix not in {".pcd", ".las", ".laz"}:
        raise HTTPException(status_code=400, detail="reference cloud must use .pcd, .las, or .laz extension")
    return suffix


def model_extension(upload: UploadFile) -> str:
    suffix = Path(upload.filename or "").suffix.lower()
    if suffix not in {".ply", ".pcd", ".las", ".laz", ".sog", ".zip"}:
        raise HTTPException(status_code=400, detail="model must use .ply, .pcd, .las, .laz, .sog, or .zip extension")
    return suffix
