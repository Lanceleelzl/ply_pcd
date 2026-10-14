"""Read optional geographic hints without changing model coordinates."""
import json
from math import isfinite
from pathlib import Path


def read_ply_coordinates(path: Path) -> dict:
    result = {"source": "", "epsg": "", "offset": [None, None, None],
              "shift": [None, None, None], "scale": [None, None, None]}
    if path.suffix.lower() != ".ply" or not path.is_file():
        return result
    comments = {}
    try:
        with path.open("rb") as stream:
            if stream.readline(16).strip() != b"ply":
                return result
            remaining = 1024 * 1024
            while remaining > 0:
                raw = stream.readline(min(remaining, 8192))
                remaining -= len(raw)
                if not raw:
                    return result
                line = raw.decode("ascii", errors="replace").strip()
                if line == "end_header":
                    break
                parts = line.split(maxsplit=2)
                if len(parts) == 3 and parts[0] == "comment":
                    comments[parts[1].lower()] = parts[2].strip()
            else:
                return result
    except OSError:
        return result
    result["source"] = comments.get("source", "")[:128]
    epsg = comments.get("epsg", "")
    if epsg.isdecimal() and 0 < int(epsg) < 1000000:
        result["epsg"] = epsg
    for kind in ("offset", "shift", "scale"):
        for index, axis in enumerate("xyz"):
            value = comments.get(kind + axis)
            try:
                if value is not None and isfinite(float(value)):
                    result[kind][index] = value
            except ValueError:
                pass
    return result


def read_model_coordinates(path: Path) -> dict:
    if path.suffix.lower() not in {".lcc", ".lcc2"}:
        return read_ply_coordinates(path)
    result = {"source": "", "epsg": "", "offset": [None, None, None],
              "shift": [None, None, None], "scale": [None, None, None],
              "axes": [-1, 3, 2]}
    try:
        metadata = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return result
    if not isinstance(metadata, dict):
        return result
    source = metadata.get("dataType") or metadata.get("source")
    if isinstance(source, str):
        result["source"] = source[:128]
    epsg = metadata.get("epsg")
    if type(epsg) is int and 0 < epsg < 1000000:
        result["epsg"] = str(epsg)
    for kind in ("offset", "shift", "scale"):
        values = metadata.get(kind)
        if not isinstance(values, list) or len(values) != 3:
            continue
        for index, value in enumerate(values):
            if type(value) in (int, float) and isfinite(value):
                result[kind][index] = str(value)
    return result
