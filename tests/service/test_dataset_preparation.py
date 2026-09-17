import json
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from service.dataset_formats import DatasetFormatError, DatasetProbe
from service.dataset_preparation import (
    _ensure_lcc_companion_names,
    prepare_gaussian_cache,
    prepare_model_dataset,
)


class DatasetPreparationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.session = Path(self.temporary.name)
        (self.session / "input").mkdir()

    def tearDown(self):
        self.temporary.cleanup()

    def test_plain_point_cloud_uses_original_compute_file(self):
        source = self.session / "input" / "model-a.pcd"
        source.write_bytes(b"pcd")
        path, details = prepare_model_dataset(
            self.session, "a", source.name,
            DatasetProbe("pcd", "file", source.name, None, True, False, False), ["converter"],
        )
        self.assertEqual(path, source)
        self.assertEqual(details["compute_path"], "input/model-a.pcd")
        self.assertIsNone(details["gaussian_path"])

    def test_sog_is_converted_for_compute_and_retained_for_display(self):
        source = self.session / "input" / "model-a.sog"
        source.write_bytes(b"sog")

        def run(command, **kwargs):
            Path(command[-1]).write_bytes(b"ply")
            return subprocess.CompletedProcess(command, 0, "", "")

        path, details = prepare_model_dataset(
            self.session, "a", source.name,
            DatasetProbe("sog", "sog", "meta.json", 2, True, True, False), ["node", "cli.mjs"], run=run,
        )
        self.assertEqual(path.read_bytes(), b"ply")
        self.assertEqual(details["compute_path"], "computed/model-a.ply")
        self.assertEqual(details["gaussian_path"], "input/model-a.sog")

    def test_spz_is_converted_for_compute_and_retained_for_display(self):
        source = self.session / "input" / "model-a.spz"
        source.write_bytes(b"spz")

        def run(command, **kwargs):
            Path(command[-1]).write_bytes(b"ply")
            return subprocess.CompletedProcess(command, 0, "", "")

        path, details = prepare_model_dataset(
            self.session, "a", source.name,
            DatasetProbe("spz", "file", source.name, None, True, True, False),
            ["node", "cli.mjs"], run=run,
        )
        self.assertEqual(path.read_bytes(), b"ply")
        self.assertEqual(details["compute_path"], "computed/model-a.ply")
        self.assertEqual(details["gaussian_path"], "input/model-a.spz")

    def test_zip_is_extracted_and_entrypoint_is_converted(self):
        source = self.session / "input" / "model-b.zip"
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr("scene/lod-meta.json", json.dumps({"lodLevels": 4}))
        observed = []

        def run(command, **kwargs):
            observed.append(command)
            Path(command[-1]).write_bytes(b"ply")
            return subprocess.CompletedProcess(command, 0, "", "")

        path, details = prepare_model_dataset(
            self.session, "b", source.name,
            DatasetProbe("streamed_sog", "zip", "scene/lod-meta.json", 1, True, True, True),
            ["node", "cli.mjs"], run=run,
        )
        self.assertTrue(path.is_file())
        self.assertEqual(
            Path(observed[0][-2]),
            self.session / "datasets" / "model-b" / "scene" / "lod-meta.json",
        )
        self.assertEqual(observed[0][3:5], ["--select-lod", "3"])
        self.assertEqual(details["gaussian_path"], "datasets/model-b/scene/lod-meta.json")
        self.assertEqual(details["compute_lod"], 3)

    def test_conversion_failure_is_explicit(self):
        source = self.session / "input" / "model-a.sog"
        source.write_bytes(b"sog")
        failed = lambda command, **kwargs: subprocess.CompletedProcess(command, 2, "", "bad input")
        with self.assertRaisesRegex(DatasetFormatError, "bad input"):
            prepare_model_dataset(
                self.session, "a", source.name,
                DatasetProbe("sog", "sog", "meta.json", 2, True, True, False), ["node", "cli.mjs"], run=failed,
            )

    def test_lcc_keeps_direct_display_when_optional_cache_conversion_fails(self):
        source = self.session / "input" / "model-a.zip"
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr("scene/meta.lcc", json.dumps({"totalLevel": 1}))
            archive.writestr("scene/Index.bin", b"index")
            archive.writestr("scene/Data.bin", b"data")
        calls = 0

        def run(command, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                Path(command[-1]).write_bytes(b"ply")
                return subprocess.CompletedProcess(command, 0, "", "")
            return subprocess.CompletedProcess(command, 2, "", "display conversion failed")

        path, details = prepare_model_dataset(
            self.session, "a", source.name,
            DatasetProbe("lcc", "zip", "scene/meta.lcc", "5.0", True, True, True),
            ["node", "cli.mjs"], run=run,
        )
        self.assertTrue(path.is_file())
        self.assertEqual(details["gaussian_path"], "datasets/model-a/scene/meta.lcc")
        self.assertTrue(details["gaussian_resource_tree"])
        status = {
            "session_id": "session", "preview_access_token": "token",
            "inputs": {"model_a_dataset": {**details, "format": "lcc"}},
        }
        prepare_gaussian_cache(self.session, status, ["node", "cli.mjs"], "a", run=run)
        self.assertEqual(status["inputs"]["model_a_dataset"]["gaussian_cache_status"], "failed")
        self.assertEqual(status["inputs"]["model_a_dataset"]["gaussian_path"], "datasets/model-a/scene/meta.lcc")

    def test_lcc_display_uses_original_resource_tree(self):
        source = self.session / "input" / "model-a.zip"
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr("meta.lcc", json.dumps({"totalLevel": 1}))
            archive.writestr("Index.bin", b"index")
            archive.writestr("Data.bin", b"data")

        def run(command, **kwargs):
            destination = Path(command[-1])
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(b"output")
            return subprocess.CompletedProcess(command, 0, "", "")

        _, details = prepare_model_dataset(
            self.session, "a", source.name,
            DatasetProbe("lcc", "zip", "meta.lcc", "5.0", True, True, True),
            ["node", "cli.mjs"], run=run,
        )
        self.assertEqual(details["gaussian_path"], "datasets/model-a/meta.lcc")
        self.assertTrue(details["gaussian_resource_tree"])

    def test_lcc_loads_directly_and_can_optionally_generate_streamed_cache(self):
        source = self.session / "input" / "model-a.zip"
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr("meta.lcc", json.dumps({"totalLevel": 1}))
            archive.writestr("Index.bin", b"index")
            archive.writestr("Data.bin", b"data")
        calls: list[Path] = []

        def run(command, **kwargs):
            destination = Path(command[-1])
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(b"output")
            calls.append(destination)
            return subprocess.CompletedProcess(command, 0, "", "")

        _, details = prepare_model_dataset(
            self.session, "a", source.name,
            DatasetProbe("lcc", "zip", "meta.lcc", "5.0", True, True, True),
            ["node", "cli.mjs"], run=run,
        )
        self.assertEqual(len(calls), 1)
        self.assertEqual(details["gaussian_path"], "datasets/model-a/meta.lcc")
        self.assertEqual(details["gaussian_cache_status"], "not_requested")
        status = {
            "session_id": "session", "preview_access_token": "token", "metadata": {},
            "inputs": {"model_a_dataset": {**details, "format": "lcc", "gaussian_status": "ready"}},
        }
        prepare_gaussian_cache(
            self.session, status, ["node", "cli.mjs"], "a", run=run,
        )
        dataset = status["inputs"]["model_a_dataset"]
        self.assertEqual(len(calls), 2)
        self.assertEqual(dataset["gaussian_cache_status"], "ready")
        self.assertEqual(dataset["gaussian_cache_progress"], 100)
        self.assertIn("/gaussian-resources/session/token/a/", status["gaussian_a_url"])

    def test_single_level_gaussian_generates_decimated_streamed_cache(self):
        source = self.session / "input" / "model-a.ply"
        source.write_bytes(b"ply\nformat binary_little_endian 1.0\nelement vertex 100\nend_header\n")
        calls: list[list[str]] = []

        def run(command, **kwargs):
            destination = Path(command[-1])
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(b"output")
            calls.append(command)
            return subprocess.CompletedProcess(command, 0, "", "")

        status = {
            "session_id": "session", "preview_access_token": "token", "metadata": {},
            "inputs": {"model_a_dataset": {
                "format": "gaussian_ply", "compute_path": "input/model-a.ply",
                "gaussian_path": "input/model-a.ply", "gaussian_status": "ready",
            }},
        }
        prepare_gaussian_cache(self.session, status, ["node", "cli.mjs"], "a", run=run)
        dataset = status["inputs"]["model_a_dataset"]
        self.assertEqual(len(calls), 4)
        self.assertEqual([call[-2] for call in calls[:3]], ["50", "25", "10"])
        self.assertIn("--tag-lod", calls[-1])
        self.assertEqual(dataset["gaussian_cache_status"], "ready")
        self.assertEqual(dataset["gaussian_cache_path"], "datasets/model-a-streamed/lod-meta.json")
        self.assertFalse((self.session / "datasets" / "model-a-streamed-build").exists())

    def test_missing_compute_copy_falls_back_to_retained_gaussian_source(self):
        source = self.session / "input" / "model-a.ply"
        source.write_bytes(b"ply\nformat binary_little_endian 1.0\nelement vertex 100\nend_header\n")
        calls: list[list[str]] = []

        def run(command, **kwargs):
            destination = Path(command[-1])
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(b"output")
            calls.append(command)
            return subprocess.CompletedProcess(command, 0, "", "")

        status = {
            "session_id": "session", "preview_access_token": "token", "metadata": {},
            "inputs": {"model_a_dataset": {
                "format": "compressed_ply",
                "compute_path": "computed/model-a.ply",
                "dataset_entrypoint": "input/model-a.ply",
                "gaussian_cache_requested": True,
            }},
        }
        prepare_gaussian_cache(self.session, status, ["node", "cli.mjs"], "a", run=run)
        self.assertIn(str(source), calls[0])
        self.assertEqual(status["inputs"]["model_a_dataset"]["gaussian_cache_status"], "ready")

    def test_lcc_companion_names_are_canonicalized_for_case_sensitive_hosts(self):
        entrypoint = self.session / "input" / "meta.lcc"
        index = entrypoint.parent / "Index.bin"
        data = entrypoint.parent / "Data.bin"
        entrypoint.write_text("{}", encoding="utf-8")
        index.write_bytes(b"index")
        data.write_bytes(b"data")
        original_is_file = Path.is_file

        def case_sensitive_is_file(path: Path) -> bool:
            if path.name in {"index.bin", "data.bin"}:
                return False
            return original_is_file(path)

        with patch.object(Path, "is_file", autospec=True, side_effect=case_sensitive_is_file), \
             patch("service.dataset_preparation.os.link") as link:
            _ensure_lcc_companion_names(entrypoint, quality=False)
        self.assertEqual(
            [(call.args[0].name, call.args[1].name) for call in link.call_args_list],
            [("Index.bin", "index.bin"), ("Data.bin", "data.bin")],
        )
