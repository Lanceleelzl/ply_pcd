# SPDX-License-Identifier: GPL-3.0-or-later
"""Bounded-memory Gaussian PLY clipping and LOD merging."""
from __future__ import annotations

import math
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Iterable

from service.ply_coordinates import read_ply_coordinates


_TYPES = {"char": "b", "uchar": "B", "short": "h", "ushort": "H", "int": "i", "uint": "I",
          "float": "f", "double": "d", "int8": "b", "uint8": "B", "int16": "h", "uint16": "H",
          "int32": "i", "uint32": "I", "float32": "f", "float64": "d"}


@dataclass(frozen=True)
class PlyLayout:
    path: Path
    count: int
    stride: int
    data_start: int
    fields: tuple[tuple[str, str, int], ...]
    header: tuple[str, ...]
    epsg: str
    offset: tuple[float, float, float]

    def field(self, name: str) -> tuple[str, int]:
        for field_name, code, position in self.fields:
            if field_name == name:
                return code, position
        raise ValueError(f"PLY 缺少 {name} 属性：{self.path.name}")


def read_layout(path: Path, require_geo: bool = False) -> PlyLayout:
    lines: list[str] = []
    with path.open("rb") as source:
        for _ in range(4096):
            raw = source.readline(8192)
            if not raw:
                raise ValueError("PLY 文件头不完整")
            line = raw.decode("ascii", "strict").rstrip("\r\n")
            lines.append(line)
            if line == "end_header":
                break
        else:
            raise ValueError("PLY 文件头过长")
        data_start = source.tell()
    if lines[:2] != ["ply", "format binary_little_endian 1.0"]:
        raise ValueError("合并目前需要二进制小端 Gaussian PLY")
    elements = [line.split() for line in lines if line.startswith("element ")]
    if len(elements) != 1 or elements[0][1] != "vertex":
        raise ValueError("PLY 仅支持单一 vertex 元素")
    count = int(elements[0][2])
    fields: list[tuple[str, str, int]] = []
    position = 0
    for line in lines:
        if not line.startswith("property "):
            continue
        parts = line.split()
        if len(parts) != 3 or parts[1] not in _TYPES:
            raise ValueError("PLY 含有不支持的属性")
        code = _TYPES[parts[1]]
        fields.append((parts[2], code, position))
        position += struct.calcsize("<" + code)
    if position == 0 or not all(any(field[0] == axis for field in fields) for axis in "xyz"):
        raise ValueError("PLY 缺少 XYZ 属性")
    required = ["opacity", *(f"f_dc_{axis}" for axis in range(3)),
                *(f"scale_{axis}" for axis in range(3)), *(f"rot_{axis}" for axis in range(4))]
    if any(not any(field[0] == name for field in fields) for name in required):
        raise ValueError("PLY 缺少 Gaussian 颜色、透明度、尺度或旋转属性")
    if path.stat().st_size != data_start + count * position:
        raise ValueError("PLY 数据长度与 vertex 数量不一致")
    location = read_ply_coordinates(path)
    if require_geo and (not location["epsg"] or any(value is None for value in location["offset"])):
        raise ValueError("PLY 必须包含 EPSG 和 offsetx／y／z")
    offset = tuple(float(value or 0) for value in location["offset"])
    return PlyLayout(path, count, position, data_start, tuple(fields), tuple(lines),
                     location["epsg"], offset)  # type: ignore[arg-type]


def _contains(polygon: list[list[float]], x: float, y: float) -> bool:
    inside = False
    previous = polygon[-1]
    for current in polygon:
        x1, y1 = previous
        x2, y2 = current
        cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1)
        if abs(cross) <= 1e-9 and min(x1, x2) - 1e-9 <= x <= max(x1, x2) + 1e-9 \
                and min(y1, y2) - 1e-9 <= y <= max(y1, y2) + 1e-9:
            return True
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
        previous = current
    return inside


def _cross(a: list[float], b: list[float], c: list[float]) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _proper_cross(a: list[float], b: list[float], c: list[float], d: list[float]) -> bool:
    return _cross(a, b, c) * _cross(a, b, d) < 0 and _cross(c, d, a) * _cross(c, d, b) < 0


def _strict_inside(polygon: list[list[float]], point: list[float]) -> bool:
    if any(abs(_cross(polygon[index - 1], polygon[index], point)) <= 1e-9 and
           min(polygon[index - 1][0], polygon[index][0]) <= point[0] <= max(polygon[index - 1][0], polygon[index][0]) and
           min(polygon[index - 1][1], polygon[index][1]) <= point[1] <= max(polygon[index - 1][1], polygon[index][1])
           for index in range(len(polygon))):
        return False
    return _contains(polygon, point[0], point[1])


def _polygons_overlap(first: list[list[float]], second: list[list[float]]) -> bool:
    if max(point[0] for point in first) <= min(point[0] for point in second) or \
            max(point[0] for point in second) <= min(point[0] for point in first) or \
            max(point[1] for point in first) <= min(point[1] for point in second) or \
            max(point[1] for point in second) <= min(point[1] for point in first):
        return False
    if {tuple(point) for point in first} == {tuple(point) for point in second}:
        return True
    if any(_strict_inside(second, point) for point in first) or any(
            _strict_inside(first, point) for point in second):
        return True
    return any(_proper_cross(first[i - 1], first[i], second[j - 1], second[j])
               for i in range(len(first)) for j in range(len(second)))


def validate_regions(regions: list[dict], model_count: int) -> None:
    for region in regions:
        polygon = region.get("polygon")
        if not isinstance(polygon, list) or len(polygon) < 3 or len(polygon) > 256:
            raise ValueError("每个裁剪范围至少需要三个顶点")
        if any(not isinstance(point, list) or len(point) != 2 or
               any(not isinstance(value, (int, float)) or not math.isfinite(value) for value in point)
               for point in polygon):
            raise ValueError("裁剪范围坐标无效")
        if region.get("kind") == "per_model":
            actions = region.get("actions")
            if not isinstance(actions, list) or len(actions) != model_count or \
                    any(type(action) is not str or action not in {"none", "remove_inside", "remove_outside"}
                        for action in actions):
                raise ValueError("裁剪范围的逐模型处理方式无效")
        elif region.get("kind") in {"clip", "select"}:
            models = region.get("models")
            if not isinstance(models, list) or not models or \
                    any(type(model) is not int or not 0 <= model < model_count for model in models) or \
                    len(set(models)) != len(models) or \
                    region.get("side") not in {"inside", "outside"}:
                raise ValueError("裁剪范围作用模型或保留方向无效")
        elif region.get("kind") not in {"keep", "remove"} or type(region.get("model")) is not int \
                or not 0 <= region["model"] < model_count:
            raise ValueError("裁剪范围目标模型无效")
        if abs(sum(_cross([0, 0], polygon[index - 1], polygon[index])
                   for index in range(len(polygon)))) <= 1e-9:
            raise ValueError("裁剪多边形面积为零")
        for first in range(len(polygon)):
            for second in range(first + 2, len(polygon)):
                if first == 0 and second == len(polygon) - 1:
                    continue
                if _proper_cross(polygon[first], polygon[(first + 1) % len(polygon)],
                                 polygon[second], polygon[(second + 1) % len(polygon)]):
                    raise ValueError("裁剪多边形不能自相交")
    keep_regions = [region for region in regions if region["kind"] == "keep"]
    for index, first in enumerate(keep_regions):
        for second in keep_regions[index + 1:]:
            if first["model"] != second["model"] and _polygons_overlap(first["polygon"], second["polygon"]):
                raise ValueError("重叠范围存在互相冲突的保留模型规则")


def _keep(x: float, y: float, model: int, regions: list[dict]) -> bool:
    for region in regions:
        if region["kind"] not in {"clip", "select", "per_model"}:
            continue
        if region["kind"] == "per_model" and region["actions"][model] == "none":
            continue
        inside = region["bounds"][0] <= x <= region["bounds"][1] and \
            region["bounds"][2] <= y <= region["bounds"][3] and _contains(region["polygon"], x, y)
        if region["kind"] == "per_model":
            action = region["actions"][model]
            if (action == "remove_inside" and inside) or (action == "remove_outside" and not inside):
                return False
        if region["kind"] == "clip" and model in region["models"] and \
                inside != (region["side"] == "inside"):
            return False
        if region["kind"] == "select" and inside == (region["side"] == "inside") and \
                model not in region["models"]:
            return False
    owners = {region["model"] for region in regions if region["kind"] == "keep"
              and region["bounds"][0] <= x <= region["bounds"][1]
              and region["bounds"][2] <= y <= region["bounds"][3]
              and _contains(region["polygon"], x, y)}
    if len(owners) > 1:
        raise ValueError("重叠范围存在互相冲突的保留模型规则")
    if any(region["kind"] == "remove" and region["model"] == model
           and region["bounds"][0] <= x <= region["bounds"][1]
           and region["bounds"][2] <= y <= region["bounds"][3]
           and _contains(region["polygon"], x, y) for region in regions):
        return False
    return not owners or model in owners


def _iter_records(layout: PlyLayout, source: BinaryIO) -> Iterable[memoryview]:
    source.seek(layout.data_start)
    remaining = layout.count
    while remaining:
        batch = min(8192, remaining)
        data = source.read(batch * layout.stride)
        if len(data) != batch * layout.stride:
            raise ValueError("PLY 数据读取中断")
        view = memoryview(data)
        for index in range(batch):
            yield view[index * layout.stride:(index + 1) * layout.stride]
        remaining -= batch


def rotate_point(rotation: tuple[float, float, float, float] | list[float],
                 point: list[float]) -> list[float]:
    w, x, y, z = rotation
    if x == y == z == 0:
        return point
    tx, ty, tz = (2 * (y * point[2] - z * point[1]),
                  2 * (z * point[0] - x * point[2]),
                  2 * (x * point[1] - y * point[0]))
    return [point[0] + w * tx + y * tz - z * ty,
            point[1] + w * ty + z * tx - x * tz,
            point[2] + w * tz + x * ty - y * tx]


def multiply_rotation(first: tuple[float, float, float, float],
                      second: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    a, b, c, d = first
    w, x, y, z = second
    return (a * w - b * x - c * y - d * z, a * x + b * w + c * z - d * y,
            a * y - b * z + c * w + d * x, a * z + b * y - c * x + d * w)


UNIT_METERS = {"m": 1.0, "cm": 0.01, "mm": 0.001}


def model_transform(model: dict, fallback_axes: tuple[int, int, int] = (1, 2, 3)
                    ) -> tuple[tuple[int, int, int], float]:
    axes = tuple(model.get("axes", fallback_axes))
    unit = model.get("unit", "m")
    scale = model.get("scale", 1.0)
    if axes not in ((1, 2, 3), (1, -3, 2)) or unit not in UNIT_METERS or \
            type(scale) not in (int, float) or not math.isfinite(scale) or scale <= 0:
        raise ValueError("模型单位、比例或上方向无效")
    return axes, UNIT_METERS[unit] * scale


def scene_vector(point: list[float] | tuple[float, ...], axes: tuple[int, int, int],
                 factor: float) -> list[float]:
    return [point[abs(axis) - 1] * (1 if axis > 0 else -1) * factor for axis in axes]


def file_vector(point: list[float], axes: tuple[int, int, int], factor: float) -> list[float]:
    result = [0.0, 0.0, 0.0]
    for scene_axis, file_axis in enumerate(axes):
        result[abs(file_axis) - 1] = point[scene_axis] * (1 if file_axis > 0 else -1) / factor
    return result


def axes_rotation(axes: tuple[int, int, int]) -> tuple[float, float, float, float]:
    return (1.0, 0.0, 0.0, 0.0) if axes == (1, 2, 3) else (
        math.sqrt(0.5), math.sqrt(0.5), 0.0, 0.0)


def conjugate(rotation: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    return (rotation[0], -rotation[1], -rotation[2], -rotation[3])


def merge_level(inputs: list[Path], destination: Path, regions: list[dict],
                correction: list[tuple[float, float, float]] | None = None,
                axes: tuple[int, int, int] = (1, 2, 3), target_model: int = 0,
                coordinates: list[dict] | None = None, output_geography: dict | None = None,
                progress=None, rotations: list[tuple[float, float, float, float]] | None = None) -> dict:
    """Two sequential passes avoid holding an output layer or temporary copy in memory."""
    layouts = [read_layout(path) for path in inputs]
    if not layouts:
        raise ValueError("至少需要一份 PLY")
    if not isinstance(target_model, int) or not 0 <= target_model < len(layouts):
        raise ValueError("目标模型无效")
    if coordinates is None:
        coordinates = []
        for layout in layouts:
            raw = read_ply_coordinates(layout.path)
            coordinates.append({"epsg": layout.epsg,
                                "offset": layout.offset if layout.epsg and all(
                                    value is not None for value in raw["offset"]) else None})
    if len(coordinates) != len(layouts):
        raise ValueError("模型坐标数量不匹配")
    known_epsg = {item["epsg"] for item in coordinates if item.get("offset") is not None}
    if len(known_epsg) > 1:
        raise ValueError("已确认模型的 EPSG 不一致")
    if any(layout.fields != layouts[0].fields for layout in layouts):
        raise ValueError("LOD PLY 属性结构不一致")
    validate_regions(regions, len(layouts))
    regions = [dict(region, bounds=(min(point[0] for point in region["polygon"]),
                                    max(point[0] for point in region["polygon"]),
                                    min(point[1] for point in region["polygon"]),
                                    max(point[1] for point in region["polygon"]))) for region in regions]
    if sorted(abs(axis) for axis in axes) != [1, 2, 3]:
        raise ValueError("东北上轴向必须分别对应不同文件轴")
    corrections = correction or [(0.0, 0.0, 0.0)] * len(layouts)
    if len(corrections) != len(layouts) or any(len(item) != 3 or not all(math.isfinite(v) for v in item)
                                                  for item in corrections):
        raise ValueError("模型校正平移无效")
    rotations = rotations or [(1.0, 0.0, 0.0, 0.0)] * len(layouts)
    if len(rotations) != len(layouts) or any(len(item) != 4 or not all(math.isfinite(v) for v in item)
                                                or abs(sum(v * v for v in item) - 1) > 1e-4
                                                for item in rotations):
        raise ValueError("模型校正旋转无效")
    transforms = [model_transform(item, axes) for item in coordinates]
    target_axes, target_factor = transforms[target_model]
    target_inverse = conjugate(axes_rotation(target_axes))
    file_rotations = [multiply_rotation(target_inverse, multiply_rotation(
        rotation, axes_rotation(model_axes))) for rotation, (model_axes, _) in zip(rotations, transforms)]
    orientation = [[layout.field(f"rot_{axis}") for axis in range(4)] for layout in layouts]
    shifts = []
    for index, (model_axes, factor) in enumerate(transforms):
        shift = scene_vector(corrections[index], model_axes, factor)
        source_geo, target_geo = coordinates[index], coordinates[target_model]
        if source_geo.get("offset") is not None and target_geo.get("offset") is not None:
            shift = [value + source_geo["offset"][axis] - target_geo["offset"][axis]
                     for axis, value in enumerate(shift)]
        shifts.append(shift)
    xyz = [[layout.field(axis) for axis in "xyz"] for layout in layouts]
    sizes = [[layout.field(f"scale_{axis}") for axis in range(3)] for layout in layouts]
    counts = [0] * len(layouts)
    bounds_min = [math.inf] * 3
    bounds_max = [-math.inf] * 3
    processed = 0
    total_records = 2 * sum(layout.count for layout in layouts)
    for writing in (False, True):
        if writing and sum(counts) == 0:
            raise ValueError("裁剪后没有保留任何高斯，请调整多边形范围")
        output = destination.open("wb") if writing else None
        try:
            if output:
                header = []
                for line in layouts[target_model].header:
                    if line.startswith("element vertex "):
                        line = f"element vertex {sum(counts)}"
                    elif line.lower().startswith("comment offset") or line.lower().startswith("comment epsg "):
                        continue
                    header.append(line)
                    if line == "format binary_little_endian 1.0":
                        geo = output_geography or coordinates[target_model]
                        if geo.get("offset") is not None:
                            header.append(f"comment epsg {geo['epsg']}")
                            for axis, value in zip("xyz", geo["offset"]):
                                header.append(f"comment offset{axis} {value:.17g}")
                output.write(("\n".join(header) + "\n").encode("ascii"))
            for model, layout in enumerate(layouts):
                with layout.path.open("rb") as source:
                    for record in _iter_records(layout, source):
                        processed += 1
                        if progress and processed % 100000 == 0:
                            progress(processed, total_records)
                        source_point = [struct.unpack_from("<" + code, record, position)[0]
                                        for code, position in xyz[model]]
                        model_axes, factor = transforms[model]
                        scene_point = rotate_point(rotations[model], scene_vector(source_point, model_axes, factor))
                        scene_point = [value + shifts[model][axis] for axis, value in enumerate(scene_point)]
                        point = file_vector(scene_point, target_axes, target_factor)
                        if not all(math.isfinite(value) for value in point):
                            continue
                        if not _keep(scene_point[0], scene_point[1], model, regions):
                            continue
                        if output:
                            data = bytearray(record)
                            for axis, (code, position) in enumerate(xyz[model]):
                                struct.pack_into("<" + code, data, position, point[axis])
                            size_adjustment = math.log(factor / target_factor)
                            if size_adjustment:
                                for code, position in sizes[model]:
                                    original_size = struct.unpack_from("<" + code, record, position)[0]
                                    struct.pack_into("<" + code, data, position, original_size + size_adjustment)
                            if file_rotations[model][1:] != (0.0, 0.0, 0.0):
                                original = tuple(struct.unpack_from("<" + code, record, position)[0]
                                                 for code, position in orientation[model])
                                rotated = multiply_rotation(file_rotations[model], original)
                                for value, (code, position) in zip(rotated, orientation[model]):
                                    struct.pack_into("<" + code, data, position, value)
                            output.write(data)
                        else:
                            counts[model] += 1
                            for axis in range(3):
                                bounds_min[axis] = min(bounds_min[axis], point[axis])
                                bounds_max[axis] = max(bounds_max[axis], point[axis])
        finally:
            if output:
                output.close()
    if progress:
        progress(total_records, total_records)
    return {"count": sum(counts), "by_model": counts, "bounds": {"min": bounds_min, "max": bounds_max},
            "epsg": (output_geography or coordinates[target_model])["epsg"] or None,
            "offset": (output_geography or coordinates[target_model])["offset"]}
