import json
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

from service.dataset_formats import DatasetFormatError, DatasetProbe
from service.dataset_preparation import prepare_model_dataset


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

    def test_zip_is_extracted_and_entrypoint_is_converted(self):
        source = self.session / "input" / "model-b.zip"
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr("scene/lod-meta.json", json.dumps({"version": 1}))
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
        self.assertEqual(observed[0][3:5], ["--select-lod", "0"])
        self.assertEqual(details["gaussian_path"], "datasets/model-b/scene/lod-meta.json")

    def test_conversion_failure_is_explicit(self):
        source = self.session / "input" / "model-a.sog"
        source.write_bytes(b"sog")
        failed = lambda command, **kwargs: subprocess.CompletedProcess(command, 2, "", "bad input")
        with self.assertRaisesRegex(DatasetFormatError, "bad input"):
            prepare_model_dataset(
                self.session, "a", source.name,
                DatasetProbe("sog", "sog", "meta.json", 2, True, True, False), ["node", "cli.mjs"], run=failed,
            )

    def test_lcc_keeps_xyz_ready_when_streamed_display_conversion_fails(self):
        source = self.session / "input" / "model-a.zip"
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr("scene/meta.lcc", "{}")
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
        self.assertIsNone(details["gaussian_path"])
        self.assertEqual(details["gaussian_error"], "display conversion failed")
        self.assertTrue(details["gaussian_resource_tree"])

    def test_lcc_display_is_converted_to_streamed_sog_tree(self):
        source = self.session / "input" / "model-a.zip"
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr("meta.lcc", "{}")
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
        self.assertEqual(details["gaussian_path"], "datasets/model-a-streamed/lod-meta.json")
        self.assertTrue(details["gaussian_resource_tree"])
