# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

from pydantic import BaseModel


class ModelRegistrationRequest(BaseModel):
    initial_moving_local_to_fixed_local: list[list[float]]
    output_direction: str = "a_to_b"
    moving_model: str = "auto"
    min_rms_decrease: float = 1.0e-5
    sampling_limit: int = 50000
    overlap: float = 1.0
    random_seed: int = 42
    show_registration_progress: bool = False
    coordinate_space: str = "file"


class TransformParameters(BaseModel):
    translation: list[float] = [0.0, 0.0, 0.0]
    rotation_degrees: list[float] = [0.0, 0.0, 0.0]
    scale: list[float] = [1.0, 1.0, 1.0]


class BusinessTransformsRequest(BaseModel):
    model_a: TransformParameters
    model_b: TransformParameters


class WorkspaceRequest(BaseModel):
    workspace_id: str
