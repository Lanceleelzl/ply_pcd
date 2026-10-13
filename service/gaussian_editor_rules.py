# SPDX-License-Identifier: GPL-3.0-or-later
"""LOD-independent spatial clipping rules for one Gaussian model."""
from __future__ import annotations

import math
import struct
from pathlib import Path
from typing import Callable

from service.gaussian_merge import _contains, read_layout, rotate_point


def validate_rules(rules: list[dict]) -> None:
    if len(rules) > 128:
        raise ValueError("裁剪边界过多")
    for rule in rules:
        if rule.get("action") not in {"keep", "remove"}:
            raise ValueError("边界必须指定保留或剔除")
        kind = rule.get("type")
        if kind == "polygon":
            points = rule.get("points")
            if not isinstance(points, list) or not 3 <= len(points) <= 256 or any(
                not _vector(point, 2) for point in points
            ):
                raise ValueError("平面边界至少需要三个有效顶点")
        elif kind == "sphere":
            if not _vector(rule.get("center"), 3) or not _positive(rule.get("radius")):
                raise ValueError("球形边界参数无效")
        elif kind == "box":
            if (not _vector(rule.get("center"), 3) or not _vector(rule.get("size"), 3)
                    or not all(_positive(value) for value in rule["size"])
                    or not _vector(rule.get("rotation"), 4)):
                raise ValueError("长方体边界参数无效")
            length = math.hypot(*rule["rotation"])
            if abs(length - 1) > 1e-5:
                raise ValueError("长方体旋转四元数必须归一化")
        else:
            raise ValueError("不支持的裁剪边界")


def _vector(value: object, size: int) -> bool:
    return isinstance(value, list) and len(value) == size and all(
        type(item) in {int, float} and math.isfinite(item) for item in value
    )


def _positive(value: object) -> bool:
    return type(value) in {int, float} and math.isfinite(value) and value > 0


def contains(rule: dict, point: tuple[float, float, float]) -> bool:
    x, y, z = point
    kind = rule["type"]
    if kind == "polygon":
        return _contains(rule["points"], x, y)
    cx, cy, cz = rule["center"]
    offset = [x - cx, y - cy, z - cz]
    if kind == "sphere":
        return sum(value * value for value in offset) <= rule["radius"] ** 2
    w, qx, qy, qz = rule["rotation"]
    local = rotate_point((w, -qx, -qy, -qz), offset)
    return all(abs(local[index]) <= rule["size"][index] / 2 for index in range(3))


def keeps_point(rules: list[dict], point: tuple[float, float, float]) -> bool:
    keep_rules = [rule for rule in rules if rule["action"] == "keep"]
    if keep_rules and not any(contains(rule, point) for rule in keep_rules):
        return False
    return not any(contains(rule, point) for rule in rules if rule["action"] == "remove")


def clip_ply(source: Path, destination: Path, rules: list[dict],
             progress: Callable[[int, int], None] | None = None) -> int:
    """Write a new binary PLY while copying every retained Gaussian attribute unchanged."""
    validate_rules(rules)
    if destination.resolve() == source.resolve() or destination.exists():
        raise ValueError("裁剪成果必须写入新的文件")
    layout = read_layout(source)
    keep_rules = [rule for rule in rules if rule["action"] == "keep"]
    remove_rules = [rule for rule in rules if rule["action"] == "remove"]
    x_field, y_field, z_field = (layout.field(axis) for axis in "xyz")
    output_header = []
    for line in layout.header:
        output_header.append("element vertex " + "0" * 20 if line.startswith("element vertex ") else line)
    header = ("\n".join(output_header) + "\n").encode("ascii")
    marker = b"element vertex " + b"0" * 20
    count_offset = header.index(marker) + len(b"element vertex ")
    destination.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    processed = 0
    with source.open("rb") as reader, destination.open("xb") as writer:
        writer.write(header)
        reader.seek(layout.data_start)
        while processed < layout.count:
            batch_size = min(8192, layout.count - processed)
            data = reader.read(batch_size * layout.stride)
            if len(data) != batch_size * layout.stride:
                raise ValueError("PLY 数据读取中断")
            kept = bytearray()
            for index in range(batch_size):
                record = memoryview(data)[index * layout.stride:(index + 1) * layout.stride]
                point = tuple(struct.unpack_from("<" + field[0], record, field[1])[0]
                              for field in (x_field, y_field, z_field))
                if (not keep_rules or any(contains(rule, point) for rule in keep_rules)) and not any(
                    contains(rule, point) for rule in remove_rules
                ):
                    kept.extend(record)
                    written += 1
            writer.write(kept)
            processed += batch_size
            if progress:
                progress(processed, layout.count)
        writer.seek(count_offset)
        writer.write(f"{written:020d}".encode("ascii"))
    return written
