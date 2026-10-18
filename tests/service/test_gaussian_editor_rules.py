from pathlib import Path

import pytest

from service.gaussian_editor_rules import clip_ply, convert_ascii_gaussian_ply, keeps_point, validate_rules
from service.gaussian_merge import read_layout


def test_2d_and_3d_rules_combine_as_keep_union_minus_removals():
    rules = [
        {"type": "polygon", "action": "keep", "points": [[-2, -2], [2, -2], [2, 2], [-2, 2]]},
        {"type": "sphere", "action": "remove", "center": [0, 0, 0], "radius": 0.5},
    ]
    validate_rules(rules)
    assert keeps_point(rules, (1, 1, 100))
    assert not keeps_point(rules, (0, 0, 0))
    assert not keeps_point(rules, (3, 0, 0))


@pytest.mark.parametrize(("points", "reason"), [
    ([[0, 0], [1, 1], [2, 2]], "面积为零"),
    ([[0, 0], [4, 4], [0, 4], [4, 0], [5, -2]], "不能自相交"),
])
def test_invalid_polygon_is_rejected_before_clipping(points, reason):
    with pytest.raises(ValueError, match=reason):
        validate_rules([{"type": "polygon", "action": "keep", "points": points}])


def test_rotated_box_and_invalid_quaternion():
    box = {"type": "box", "action": "keep", "center": [0, 0, 0],
           "size": [2, 1, 1], "rotation": [0.7071067811865476, 0, 0, 0.7071067811865476]}
    validate_rules([box])
    assert keeps_point([box], (0, 0.9, 0))
    assert not keeps_point([box], (0.9, 0, 0))
    box["rotation"] = [1, 1, 0, 0]
    with pytest.raises(ValueError):
        validate_rules([box])


def test_streamed_clip_preserves_file_and_updates_count(tmp_path: Path):
    source = Path(__file__).parent / "gaussian-small-binary.ply"
    destination = tmp_path / "edited.ply"
    count = clip_ply(source, destination, [], None)
    assert count == read_layout(source).count
    assert read_layout(destination).count == count
    assert source.read_bytes() != b""
    with pytest.raises(ValueError):
        clip_ply(source, source, [])


def test_ascii_gaussian_ply_converts_before_cross_lod_clip(tmp_path: Path):
    source = Path(__file__).parent / "gaussian-small.ply"
    binary = tmp_path / "work.ply"
    result = tmp_path / "edited.ply"
    convert_ascii_gaussian_ply(source, binary)
    assert read_layout(binary).count == 4
    rules = [{"type": "sphere", "action": "keep", "center": [0, 0, 0], "radius": 0.6}]
    assert clip_ply(binary, result, rules) == 1
    assert read_layout(result).count == 1


def test_clip_rules_use_transformed_scene_coordinates(tmp_path: Path):
    source = Path(__file__).parent / "gaussian-small-binary.ply"
    destination = tmp_path / "transformed-selection.ply"
    rules = [{"type": "sphere", "action": "keep", "center": [10, 20, 30], "radius": 0.6}]
    count = clip_ply(source, destination, rules,
                     to_common=lambda point: (point[0] + 10, point[1] + 20, point[2] + 30))
    assert count == 1
