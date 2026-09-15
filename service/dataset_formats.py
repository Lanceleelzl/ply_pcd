# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

import json
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath
from typing import Any


class DatasetFormatError(ValueError):
    pass


MAX_DATASET_FILES = 100_000
MAX_DATASET_UNCOMPRESSED_BYTES = 100 * 1024**3
MAX_ZIP_COMPRESSION_RATIO = 200


@dataclass(frozen=True)
class DatasetProbe:
    format: str
    container: str
    entrypoint: str
    version: str | int | None
    xyz_capable: bool
    gaussian_capable: bool
    streaming_capable: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _safe_member(name: str) -> PurePosixPath:
    normalized = name.replace("\\", "/")
    path = PurePosixPath(normalized)
    if not normalized or path.is_absolute() or ".." in path.parts:
        raise DatasetFormatError(f"Unsafe dataset path: {name}")
    if path.parts and ":" in path.parts[0]:
        raise DatasetFormatError(f"Unsafe dataset path: {name}")
    return path


def _single_common_root(paths: list[PurePosixPath]) -> str | None:
    roots = {path.parts[0] for path in paths if len(path.parts) > 1}
    return next(iter(roots)) if len(roots) == 1 and all(len(path.parts) > 1 for path in paths) else None


def _relative_paths(names: list[str]) -> tuple[list[PurePosixPath], str | None]:
    paths = [_safe_member(name) for name in names if name and not name.endswith(("/", "\\"))]
    root = _single_common_root(paths)
    if root:
        paths = [PurePosixPath(*path.parts[1:]) for path in paths]
    return paths, root


def _json_from_zip(archive: zipfile.ZipFile, original_name: str) -> dict[str, Any]:
    try:
        value = json.loads(archive.read(original_name))
    except (KeyError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DatasetFormatError(f"Invalid JSON entrypoint: {original_name}") from error
    if not isinstance(value, dict):
        raise DatasetFormatError(f"Dataset entrypoint must be a JSON object: {original_name}")
    return value


def _sog_references(metadata: dict[str, Any]) -> list[str]:
    files: list[str] = []
    for section in ("means", "scales", "quats", "sh0", "shN"):
        value = metadata.get(section)
        if isinstance(value, dict) and isinstance(value.get("files"), list):
            files.extend(value["files"])
    return files


def _validate_stream_tree(tree: dict[str, Any], lod_levels: int,
                          chunk_counts: list[int]) -> None:
    intervals: list[list[tuple[int, int]]] = [[] for _ in chunk_counts]

    def visit(node: Any) -> None:
        if not isinstance(node, dict) or not isinstance(node.get("bound"), dict):
            raise DatasetFormatError("Streamed SOG tree nodes must contain a bound object")
        children = node.get("children")
        lods = node.get("lods")
        if children is not None:
            if lods is not None or not isinstance(children, list) or len(children) != 2:
                raise DatasetFormatError("Streamed SOG branch nodes must contain exactly two children")
            for child in children:
                visit(child)
            return
        if not isinstance(lods, dict) or not lods:
            raise DatasetFormatError("Streamed SOG leaf nodes must contain lods")
        for level, reference in lods.items():
            try:
                lod = int(level)
            except (TypeError, ValueError) as error:
                raise DatasetFormatError(f"Invalid Streamed SOG LOD level: {level}") from error
            if not 0 <= lod < lod_levels or not isinstance(reference, dict):
                raise DatasetFormatError(f"Invalid Streamed SOG LOD reference: {level}")
            file_index = reference.get("file")
            offset = reference.get("offset")
            count = reference.get("count")
            if (not isinstance(file_index, int) or not 0 <= file_index < len(chunk_counts)
                    or not isinstance(offset, int) or offset < 0
                    or not isinstance(count, int) or count <= 0
                    or offset + count > chunk_counts[file_index]):
                raise DatasetFormatError(f"Streamed SOG LOD range is out of bounds: {reference}")
            intervals[file_index].append((offset, offset + count))

    visit(tree)
    for index, ranges in enumerate(intervals):
        ordered = sorted(ranges)
        if (not ordered or ordered[0][0] != 0 or ordered[-1][1] != chunk_counts[index]
                or any(left[1] != right[0] for left, right in zip(ordered, ordered[1:]))):
            raise DatasetFormatError(f"Streamed SOG chunk ranges must cover file {index} exactly once")


def probe_zip(path: Path) -> DatasetProbe:
    try:
        archive = zipfile.ZipFile(path)
    except zipfile.BadZipFile as error:
        raise DatasetFormatError("Invalid ZIP or SOG container") from error
    with archive:
        infos = archive.infolist()
        files = [info for info in infos if not info.is_dir()]
        if len(files) > MAX_DATASET_FILES:
            raise DatasetFormatError(f"Dataset contains more than {MAX_DATASET_FILES} files")
        total_size = sum(info.file_size for info in files)
        compressed_size = sum(max(info.compress_size, 1) for info in files)
        if total_size > MAX_DATASET_UNCOMPRESSED_BYTES:
            raise DatasetFormatError("Dataset uncompressed size exceeds 100 GiB")
        if total_size > compressed_size * MAX_ZIP_COMPRESSION_RATIO:
            raise DatasetFormatError("Dataset ZIP compression ratio exceeds the safety limit")
        if any((info.external_attr >> 16) & 0o170000 == 0o120000 for info in infos):
            raise DatasetFormatError("Dataset ZIP symbolic links are not supported")
        if any(info.flag_bits & 0x1 for info in infos):
            raise DatasetFormatError("Encrypted ZIP datasets are not supported")
        names = [info.filename for info in infos]
        relative, root = _relative_paths(names)
        mapped = {
            str(relative_path): original
            for relative_path, original in zip(
                relative,
                [name for name in names if name and not name.endswith(("/", "\\"))],
                strict=True,
            )
        }
        lod_entries = [name for name in mapped if name == "lod-meta.json"]
        lcc_entries = [name for name in mapped if name.lower().endswith(".lcc")]
        lcc2_entries = [name for name in mapped if name.lower().endswith(".lcc2")]
        meta_entries = [name for name in mapped if name == "meta.json"]

        groups = sum(bool(entries) for entries in (lod_entries, lcc_entries, lcc2_entries))
        if groups > 1:
            raise DatasetFormatError("Dataset contains multiple scene entrypoint types")
        prefix = f"{root}/" if root else ""
        if lod_entries:
            metadata = _json_from_zip(archive, mapped[lod_entries[0]])
            lod_levels = metadata.get("lodLevels")
            if not isinstance(lod_levels, int) or lod_levels <= 0:
                raise DatasetFormatError("Streamed SOG lodLevels must be a positive integer")
            filenames = metadata.get("filenames")
            if (not isinstance(filenames, list) or not filenames
                    or any(not isinstance(name, str) for name in filenames)):
                raise DatasetFormatError("Streamed SOG filenames must be a non-empty string array")
            if len(set(filenames)) != len(filenames):
                raise DatasetFormatError("Streamed SOG filenames must be unique")
            if not isinstance(metadata.get("tree"), dict):
                raise DatasetFormatError("Streamed SOG tree must be an object")
            parent = PurePosixPath(lod_entries[0]).parent
            referenced = [str(parent / _safe_member(name)) for name in filenames]
            missing = [name for name in referenced if name not in mapped]
            chunk_counts: list[int] = []
            for relative_name, archive_name in zip(referenced, filenames, strict=True):
                if relative_name not in mapped:
                    continue
                chunk = _json_from_zip(archive, mapped[relative_name])
                if chunk.get("version") != 2:
                    raise DatasetFormatError(f"Unsupported streamed SOG chunk version: {chunk.get('version')}")
                count = chunk.get("count")
                if not isinstance(count, int) or count < 0:
                    raise DatasetFormatError(f"Invalid streamed SOG chunk count: {archive_name}")
                chunk_counts.append(count)
                chunk_parent = PurePosixPath(relative_name).parent
                for name in _sog_references(chunk):
                    if not isinstance(name, str):
                        missing.append(f"{archive_name}:<invalid reference>")
                        continue
                    resource = str(chunk_parent / _safe_member(name))
                    if resource not in mapped:
                        missing.append(resource)
            if missing:
                raise DatasetFormatError(f"Streamed SOG is missing referenced entries: {missing}")
            _validate_stream_tree(metadata["tree"], lod_levels, chunk_counts)
            return DatasetProbe("streamed_sog", "zip", prefix + lod_entries[0], 1, True, True, True)
        if lcc_entries:
            if len(lcc_entries) != 1:
                raise DatasetFormatError("LCC dataset must contain exactly one .lcc entrypoint")
            lower = {name.lower() for name in mapped}
            parent = PurePosixPath(lcc_entries[0]).parent
            required = [str(parent / name).lower() for name in ("Index.bin", "Data.bin")]
            missing = [name for name in required if name not in lower]
            if missing:
                raise DatasetFormatError(f"LCC dataset is missing required entries: {missing}")
            metadata = _json_from_zip(archive, mapped[lcc_entries[0]])
            version = metadata.get("version")
            if version != "5.0":
                raise DatasetFormatError(f"Unsupported LCC version: {version}")
            file_type = metadata.get("fileType")
            if file_type not in {"Portable", "Quality"}:
                raise DatasetFormatError(f"Unsupported LCC fileType: {file_type}")
            shcoef = str(parent / "Shcoef.bin").lower()
            if file_type == "Quality" and shcoef not in lower:
                raise DatasetFormatError("LCC Quality dataset is missing required Shcoef.bin")
            return DatasetProbe("lcc", "zip", prefix + lcc_entries[0], version, True, True, True)
        if lcc2_entries:
            if len(lcc2_entries) != 1:
                raise DatasetFormatError("LCC2 dataset must contain exactly one .lcc2 entrypoint")
            metadata = _json_from_zip(archive, mapped[lcc2_entries[0]])
            version = metadata.get("version")
            if version != "0.0.3":
                raise DatasetFormatError(f"Unsupported LCC2 version: {version}")
            root_metadata = metadata.get("root")
            splat_files = root_metadata.get("splatFiles") if isinstance(root_metadata, dict) else None
            if not isinstance(splat_files, list) or not splat_files:
                raise DatasetFormatError("LCC2 root.splatFiles must be a non-empty array")
            if not isinstance(metadata.get("totalLevels"), int) or metadata["totalLevels"] <= 0:
                raise DatasetFormatError("LCC2 totalLevels must be a positive integer")
            if not isinstance(metadata.get("totalSplats"), int) or metadata["totalSplats"] < 0:
                raise DatasetFormatError("LCC2 totalSplats must be a non-negative integer")
            lod_splats = metadata.get("lodSplats")
            if not isinstance(lod_splats, list) or len(lod_splats) != metadata["totalLevels"]:
                raise DatasetFormatError("LCC2 lodSplats must match totalLevels")
            splat_type = metadata.get("splatType", ".sog").lower()
            if splat_type not in {".ply", ".spz", ".sog"}:
                raise DatasetFormatError(f"Unsupported LCC2 splatType: {splat_type}")
            parent = PurePosixPath(lcc2_entries[0]).parent
            missing = [str(parent / name) for name in splat_files
                       if not isinstance(name, str) or str(parent / name) not in mapped]
            if missing:
                raise DatasetFormatError(f"LCC2 is missing referenced splat files: {missing}")
            return DatasetProbe("lcc2", "zip", prefix + lcc2_entries[0], version, True, True, True)
        if len(meta_entries) == 1:
            metadata = _json_from_zip(archive, mapped[meta_entries[0]])
            version = metadata.get("version")
            if version != 2:
                raise DatasetFormatError(f"Unsupported SOG version: {version}")
            files = _sog_references(metadata)
            parent = PurePosixPath(meta_entries[0]).parent
            required = [str(parent / name) for name in files if isinstance(name, str)]
            missing = [name for name in required if name not in mapped]
            if missing:
                raise DatasetFormatError(f"SOG is missing referenced entries: {missing}")
            return DatasetProbe("sog", "zip", prefix + meta_entries[0], version, True, True, False)
        raise DatasetFormatError("ZIP does not contain a supported dataset entrypoint")


def _ply_probe(path: Path) -> DatasetProbe:
    with path.open("rb") as stream:
        header = stream.read(256 * 1024)
    end = header.find(b"end_header")
    if not header.startswith(b"ply\n") and not header.startswith(b"ply\r\n"):
        raise DatasetFormatError("Invalid PLY signature")
    if end < 0:
        raise DatasetFormatError("PLY header exceeds 256 KiB or is incomplete")
    text = header[:end].decode("ascii", errors="strict")
    binary_little_endian = "format binary_little_endian " in text
    properties = {line.split()[-1] for line in text.splitlines() if line.startswith("property ")}
    if not {"x", "y", "z"}.issubset(properties) and "packed_position" not in properties:
        raise DatasetFormatError("PLY has no supported XYZ position properties")
    compressed = "element chunk " in text and "packed_position" in properties
    gaussian_properties = compressed or {"scale_0", "scale_1", "rot_0", "rot_1", "rot_2", "rot_3", "opacity"}.issubset(properties)
    format_name = "compressed_ply" if compressed else ("gaussian_ply" if gaussian_properties else "ply")
    return DatasetProbe(format_name, "file", path.name, None, True,
                        compressed or gaussian_properties and binary_little_endian, False)


def probe_dataset(path: Path) -> DatasetProbe:
    suffix = path.suffix.lower()
    if suffix in {".zip", ".sog"}:
        result = probe_zip(path)
        if suffix == ".sog" and result.format != "sog":
            raise DatasetFormatError("A .sog file must contain exactly one SOG dataset")
        return DatasetProbe(result.format, "sog" if suffix == ".sog" else result.container,
                            result.entrypoint, result.version, result.xyz_capable,
                            result.gaussian_capable, result.streaming_capable)
    if suffix == ".ply":
        return _ply_probe(path)
    if suffix in {".pcd", ".las", ".laz"}:
        return DatasetProbe(suffix[1:], "file", path.name, None, True, False, False)
    raise DatasetFormatError(f"Unsupported dataset extension: {suffix or '<none>'}")
