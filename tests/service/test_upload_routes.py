import io
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException, UploadFile

from service.dataset_formats import DatasetProbe
from service.routes.uploads import create_upload_router


class UploadRoutesTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.write = Mock()
        self.start = Mock()
        self.archive = Mock()
        router = create_upload_router(
            lambda _: Path("runtime/manual-sessions/test-session"),
            self.write, "worker", 24, self.archive, self.start,
        )
        self.create = router.routes[0].endpoint
        self.a = UploadFile(filename="scene.ply", file=io.BytesIO(b"a"))
        self.b = UploadFile(filename="map.pcd", file=io.BytesIO(b"b"))

    async def asyncTearDown(self):
        await self.a.close()
        await self.b.close()

    async def test_success_records_inputs_and_starts_preview(self):
        with patch.object(Path, "mkdir"), patch(
            "service.routes.uploads._save_upload_with_sha256",
            new=AsyncMock(side_effect=[(1, "a-hash"), (1, "b-hash")]),
        ) as save, patch(
            "service.routes.uploads._probe_dataset",
            side_effect=[
                DatasetProbe("gaussian_ply", "file", "model-a.ply", None, True, True, False),
                DatasetProbe("pcd", "file", "model-b.pcd", None, True, False, False),
            ],
        ):
            response = await self.create(self.a, self.b)
        status = self.write.call_args.args[1]
        self.assertEqual(response["status"], "queued")
        self.assertEqual(status["inputs"]["model_a_sha256"], "a-hash")
        self.assertEqual(status["inputs"]["model_b_original_filename"], "map.pcd")
        self.assertEqual(status["inputs"]["model_a_dataset"]["format"], "gaussian_ply")
        self.assertTrue(status["inputs"]["model_a_dataset"]["gaussian_capable"])
        self.assertEqual(save.await_count, 2)
        self.assertEqual(status["business_transforms"]["a"]["scale"], [1, 1, 1])
        self.start.assert_called_once()
        self.archive.assert_called_once()
        self.assertEqual(self.start.call_args.args[1][:2], ["worker", "prepare-model-preview"])

    async def test_directory_upload_is_packaged_and_records_shape(self):
        directory_files = [UploadFile(filename="scene/lod-meta.json", file=io.BytesIO(b"{}"))]
        try:
            with patch.object(Path, "mkdir"), patch(
                "service.routes.uploads._save_upload_with_sha256",
                new=AsyncMock(return_value=(1, "b-hash")),
            ), patch(
                "service.routes.uploads._save_upload_directory_with_sha256",
                new=AsyncMock(return_value=(2, "a-hash")),
            ) as save_directory, patch(
                "service.routes.uploads._probe_dataset",
                side_effect=[
                    DatasetProbe("lcc", "zip", "scene/meta.lcc", "5.0", True, True, True),
                    DatasetProbe("pcd", "file", "model-b.pcd", None, True, False, False),
                ],
            ):
                await self.create(None, self.b, directory_files, None, model_a_stream_cache=True)
            status = self.write.call_args.args[1]
            self.assertEqual(status["model_a_filename"], "model-a.zip")
            self.assertEqual(status["inputs"]["model_a_original_filename"], "scene")
            self.assertEqual(status["inputs"]["model_a_upload_shape"], "directory")
            self.assertEqual(status["inputs"]["model_b_upload_shape"], "file")
            self.assertTrue(status["inputs"]["model_a_dataset"]["gaussian_cache_requested"])
            save_directory.assert_awaited_once()
        finally:
            for upload in directory_files:
                await upload.close()

    async def test_spz_single_file_is_accepted(self):
        spz = UploadFile(filename="point_cloud_5.spz", file=io.BytesIO(b"spz"))
        try:
            with patch.object(Path, "mkdir"), patch(
                "service.routes.uploads._save_upload_with_sha256",
                new=AsyncMock(side_effect=[(3, "spz-hash"), (1, "b-hash")]),
            ), patch(
                "service.routes.uploads._probe_dataset",
                side_effect=[
                    DatasetProbe("spz", "file", "model-a.spz", None, True, True, False),
                    DatasetProbe("pcd", "file", "model-b.pcd", None, True, False, False),
                ],
            ):
                response = await self.create(spz, self.b, model_a_stream_cache=True)
            status = self.write.call_args.args[1]
            self.assertEqual(response["status"], "queued")
            self.assertEqual(status["model_a_filename"], "model-a.spz")
            self.assertEqual(status["inputs"]["model_a_format"], "spz")
            self.assertTrue(status["inputs"]["model_a_dataset"]["gaussian_cache_requested"])
        finally:
            await spz.close()

    async def test_rejects_stream_cache_for_plain_point_cloud(self):
        with patch.object(Path, "mkdir"), patch(
            "service.routes.uploads._save_upload_with_sha256",
            new=AsyncMock(side_effect=[(1, "a-hash"), (1, "b-hash")]),
        ), patch(
            "service.routes.uploads._probe_dataset",
            side_effect=[
                DatasetProbe("ply", "file", "model-a.ply", None, True, False, False),
                DatasetProbe("pcd", "file", "model-b.pcd", None, True, False, False),
            ],
        ):
            with self.assertRaises(HTTPException) as error:
                await self.create(self.a, self.b, model_a_stream_cache=True)
        self.assertEqual(error.exception.status_code, 400)
        self.assertIn("Gaussian", error.exception.detail)

    async def test_rejects_missing_or_ambiguous_upload_shape(self):
        with self.assertRaises(HTTPException) as missing:
            await self.create(None, self.b)
        self.assertEqual(missing.exception.status_code, 400)
        extra = [UploadFile(filename="scene/meta.json", file=io.BytesIO(b"{}"))]
        try:
            with self.assertRaises(HTTPException) as ambiguous:
                await self.create(self.a, self.b, extra, None)
            self.assertEqual(ambiguous.exception.status_code, 400)
        finally:
            await extra[0].close()

    async def test_empty_upload_does_not_start_preview(self):
        with patch.object(Path, "mkdir"), patch(
            "service.routes.uploads._save_upload_with_sha256",
            new=AsyncMock(side_effect=[(0, "empty"), (1, "b-hash")]),
        ), patch("service.routes.uploads.shutil.rmtree") as cleanup:
            with self.assertRaises(HTTPException) as error:
                await self.create(self.a, self.b)
        self.assertEqual(error.exception.status_code, 400)
        cleanup.assert_called_once()
        self.write.assert_not_called()
        self.start.assert_not_called()
        self.archive.assert_not_called()

    async def test_object_archive_failure_rolls_back_session(self):
        self.archive.side_effect = RuntimeError("storage unavailable")
        with patch.object(Path, "mkdir"), patch(
            "service.routes.uploads._save_upload_with_sha256",
            new=AsyncMock(side_effect=[(1, "a-hash"), (1, "b-hash")]),
        ), patch("service.routes.uploads._probe_dataset", side_effect=[
            DatasetProbe("ply", "file", "model-a.ply", None, True, False, False),
            DatasetProbe("pcd", "file", "model-b.pcd", None, True, False, False),
        ]), patch("service.routes.uploads.shutil.rmtree") as cleanup:
            with self.assertRaises(HTTPException) as error:
                await self.create(self.a, self.b)
        self.assertEqual(error.exception.status_code, 502)
        cleanup.assert_called_once()
        self.write.assert_not_called()
        self.start.assert_not_called()

    async def test_invalid_parameters_do_not_write_files(self):
        for params in (
            {"output_direction": "invalid"}, {"moving_model": "invalid"},
            {"workspace_id": "invalid"}, {"model_a_transform": "invalid-json"},
        ):
            with self.subTest(params=params), patch.object(Path, "mkdir") as mkdir:
                with self.assertRaises(HTTPException) as error:
                    await self.create(self.a, self.b, **params)
                self.assertEqual(error.exception.status_code, 400)
                mkdir.assert_not_called()
        self.start.assert_not_called()
