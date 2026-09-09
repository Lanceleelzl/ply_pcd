import io
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException, UploadFile

from service.routes.uploads import create_upload_router


class UploadRoutesTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.write = Mock()
        self.start = Mock()
        router = create_upload_router(
            lambda _: Path("runtime/manual-sessions/test-session"),
            self.write, "worker", 24, self.start,
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
        ) as save:
            response = await self.create(self.a, self.b)
        status = self.write.call_args.args[1]
        self.assertEqual(response["status"], "queued")
        self.assertEqual(status["inputs"]["model_a_sha256"], "a-hash")
        self.assertEqual(status["inputs"]["model_b_original_filename"], "map.pcd")
        self.assertEqual(save.await_count, 2)
        self.assertEqual(status["business_transforms"]["a"]["scale"], [1, 1, 1])
        self.start.assert_called_once()
        self.assertEqual(self.start.call_args.args[1][:2], ["worker", "prepare-model-preview"])

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
