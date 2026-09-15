import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

from service.dataset_formats import probe_dataset
from service.dataset_preparation import prepare_model_dataset


class SplatTransformIntegrationTest(unittest.TestCase):
    def test_compressed_ply_and_sog_restore_xyz_ply(self):
        root = Path(__file__).resolve().parents[2]
        cli = root / "node_modules" / "@playcanvas" / "splat-transform" / "bin" / "cli.mjs"
        source = Path(__file__).with_name("gaussian-small-binary.ply")
        ascii_source = Path(__file__).with_name("gaussian-small.ply")
        self.assertTrue(cli.is_file(), "pnpm install must provide the pinned SplatTransform CLI")
        self.assertEqual(probe_dataset(ascii_source).format, "gaussian_ply")
        self.assertFalse(probe_dataset(ascii_source).gaussian_capable)
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            compressed = output / "small.compressed.ply"
            sog = output / "small.sog"
            restored_compressed = output / "compressed-restored.ply"
            restored_sog = output / "sog-restored.ply"
            for command in (
                ["node", str(cli), "--overwrite", str(source), str(compressed)],
                ["node", str(cli), "--overwrite", str(compressed), str(restored_compressed)],
                ["node", str(cli), "--overwrite", str(source), str(sog)],
                ["node", str(cli), "--overwrite", str(sog), str(restored_sog)],
            ):
                subprocess.run(command, check=True, capture_output=True, text=True, encoding="utf-8",
                               errors="replace", timeout=30)
            self.assertEqual(probe_dataset(compressed).format, "compressed_ply")
            self.assertEqual(probe_dataset(sog).format, "sog")
            self.assertEqual(probe_dataset(restored_compressed).format, "gaussian_ply")
            self.assertEqual(probe_dataset(restored_sog).format, "gaussian_ply")

    def test_streamed_sog_directory_package_restores_lod0_xyz(self):
        root = Path(__file__).resolve().parents[2]
        cli = root / "node_modules" / "@playcanvas" / "splat-transform" / "bin" / "cli.mjs"
        source = Path(__file__).with_name("gaussian-small-binary.ply")
        with tempfile.TemporaryDirectory() as temporary:
            session = Path(temporary) / "session"
            generated = Path(temporary) / "generated"
            generated.mkdir()
            subprocess.run([
                "node", str(cli), "--overwrite", str(source), str(generated / "lod-meta.json"),
                "--lod-chunk-count", "1", "--lod-chunk-min", "1", "--max-workers", "0",
            ], check=True, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
            inputs = session / "input"
            inputs.mkdir(parents=True)
            package = inputs / "model-a.zip"
            with zipfile.ZipFile(package, "w", compression=zipfile.ZIP_STORED) as archive:
                for path in generated.rglob("*"):
                    if path.is_file():
                        archive.write(path, (Path("scene") / path.relative_to(generated)).as_posix())
            probe = probe_dataset(package)
            self.assertEqual(probe.format, "streamed_sog")
            computed, prepared = prepare_model_dataset(
                session, "a", package.name, probe, ["node", str(cli)],
            )
            self.assertTrue(computed.is_file())
            self.assertEqual(probe_dataset(computed).format, "gaussian_ply")
            self.assertEqual(prepared["gaussian_path"], "datasets/model-a/scene/lod-meta.json")
