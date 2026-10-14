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
             progress: Callable[[int, int], None] | None = None,
             to_common: Callable[[tuple[float, float, float]], tuple[float, float, float]] | None = None) -> int:
    """Write a new binary PLY while copying every retained Gaussian attribute unchanged."""
    validate_rules(rules)
    if destination.resolve() == source.resolve() or destination.exists():
        raise ValueError("裁剪成果必须写入新的文件")
    layout = read_layout(source)
    keep_rules = [rule for rule in rules if rule["action"] == "keep"]
    remove_rules = [rule for rule in rules if rule["action"] == "remove"]
    x_field, y_field, z_field = (layout.field(axis) for axis in "xyz")
    output_header = []
    bound_offsets: dict[str, list[int]] = {}
    header_size = 0
    for line in layout.header:
        parts = line.split(maxsplit=2)
        if line.startswith("element vertex "):
            encoded = ("element vertex " + "0" * 20 + "\n").encode("ascii")
        elif len(parts) >= 2 and parts[0] == "comment" and parts[1] in {
                "minx", "miny", "minz", "maxx", "maxy", "maxz"}:
            key = parts[1]
            prefix = f"comment {key} ".encode("ascii")
            bound_offsets.setdefault(key, []).append(header_size + len(prefix))
            encoded = prefix + b" " * 30 + b"\n"
        else:
            encoded = (line + "\n").encode("ascii")
        output_header.append(encoded)
        header_size += len(encoded)
    header = b"".join(output_header)
    marker = b"element vertex " + b"0" * 20
    count_offset = header.index(marker) + len(b"element vertex ")
    destination.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    processed = 0
    minimum = [math.inf] * 3
    maximum = [-math.inf] * 3
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
                common_point = to_common(point) if to_common else point
                if (not keep_rules or any(contains(rule, common_point) for rule in keep_rules)) and not any(
                    contains(rule, common_point) for rule in remove_rules
                ):
                    kept.extend(record)
                    written += 1
                    for axis, value in enumerate(point):
                        if math.isfinite(value):
                            minimum[axis] = min(minimum[axis], value)
                            maximum[axis] = max(maximum[axis], value)
            writer.write(kept)
            processed += batch_size
            if progress:
                progress(processed, layout.count)
        writer.seek(count_offset)
        writer.write(f"{written:020d}".encode("ascii"))
        for key, offsets in bound_offsets.items():
            axis = "xyz".index(key[-1])
            value = minimum[axis] if key.startswith("min") else maximum[axis]
            encoded = f"{value if math.isfinite(value) else 0:.17g}".rjust(30).encode("ascii")
            for offset in offsets:
                writer.seek(offset)
                writer.write(encoded)
    return written


def convert_ascii_gaussian_ply(source: Path, destination: Path) -> None:
    """Stream an ASCII vertex-only Gaussian PLY into binary little-endian PLY."""
    formats = {"char": "b", "uchar": "B", "short": "h", "ushort": "H", "int": "i", "uint": "I",
               "float": "f", "double": "d", "int8": "b", "uint8": "B", "int16": "h", "uint16": "H",
               "int32": "i", "uint32": "I", "float32": "f", "float64": "d"}
    if source.resolve() == destination.resolve() or destination.exists():
        raise ValueError("转换结果必须写入新文件")
    with source.open("rb") as reader:
        header: list[str] = []
        size = 0
        while size < 256 * 1024:
            raw = reader.readline(8192)
            size += len(raw)
            if not raw:
                break
            line = raw.decode("ascii").strip()
            header.append(line)
            if line == "end_header":
                break
        if header[:2] != ["ply", "format ascii 1.0"] or header[-1] != "end_header":
            raise ValueError("仅支持完整的 ASCII PLY 1.0")
        elements = [line.split() for line in header if line.startswith("element ")]
        if len(elements) != 1 or elements[0][:2] != ["element", "vertex"]:
            raise ValueError("ASCII PLY 仅支持单一 vertex 元素")
        count = int(elements[0][2])
        if count < 0:
            raise ValueError("PLY 顶点数量无效")
        properties = [line.split() for line in header if line.startswith("property ")]
        if not properties or any(len(item) != 3 or item[1] not in formats for item in properties):
            raise ValueError("ASCII PLY 含有不支持的属性")
        if not {"x", "y", "z"}.issubset({item[2] for item in properties}):
            raise ValueError("PLY 缺少 XYZ 坐标")
        packer = struct.Struct("<" + "".join(formats[item[1]] for item in properties))
        binary_header = ["format binary_little_endian 1.0" if line == "format ascii 1.0" else line
                         for line in header]
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open("xb") as writer:
            writer.write(("\n".join(binary_header) + "\n").encode("ascii"))
            for _ in range(count):
                fields = reader.readline().split()
                if len(fields) != len(properties):
                    raise ValueError("ASCII PLY 顶点数量或属性不完整")
                values = [float(value) if formats[item[1]] in "fd" else int(value)
                          for value, item in zip(fields, properties)]
                if not all(math.isfinite(value) for value in values):
                    raise ValueError("ASCII PLY 含有非有限数值")
                writer.write(packer.pack(*values))
