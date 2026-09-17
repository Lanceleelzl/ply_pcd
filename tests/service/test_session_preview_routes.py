import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi import HTTPException

from service.routes.sessions import create_session_router
from service.schemas import WorkspaceRequest


class SessionPreviewRoutesTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.status = {
            "api_version": "v2", "workspace_id": "workspace", "status": "failed",
            "editor_url": "/registration/session", "model_a_filename": "a.ply",
            "model_b_filename": "b.pcd", "error": "old error", "error_code": "old",
        }
        self.start = Mock()
        self.start_cache = Mock()
        self.available = Mock(return_value=True)
        self.restore = Mock(return_value=True)
        self.write = Mock(side_effect=lambda _, value: self.status.update(value))
        router = create_session_router(
            lambda _: Path("runtime/manual-sessions/session"), lambda _: Path("runtime/jobs/job"),
            lambda _: dict(self.status), self.write, self.available, lambda value: value,
            Mock(), Mock(), Mock(), 24, "worker", self.restore, self.start, self.start_cache,
        )
        self.routes = {route.name: route.endpoint for route in router.routes}

    async def resume(self):
        return await self.routes["resume_model_registration_session"](
            "session", WorkspaceRequest(workspace_id="workspace"),
        )

    async def test_missing_preview_queues_once(self):
        with patch.object(Path, "is_file", return_value=False), patch.object(Path, "mkdir"):
            first = await self.resume()
            second = await self.resume()
        self.assertEqual(first["status"], "queued")
        self.assertEqual(first, second)
        self.start.assert_called_once()
        self.restore.assert_called()
        command = self.start.call_args.args[1]
        self.assertEqual(command[:2], ["worker", "prepare-model-preview"])
        self.assertNotIn("error", self.write.call_args.args[1])

    async def test_ready_preview_does_not_start_worker(self):
        self.status["status"] = "ready"
        with patch.object(Path, "is_file", return_value=True):
            response = await self.resume()
        self.assertEqual(response["status"], "ready")
        self.start.assert_not_called()

    async def test_missing_computed_dataset_rebuilds_ready_preview(self):
        self.status["status"] = "ready"
        self.status["inputs"] = {
            "model_a_dataset": {"compute_path": "computed/model-a.ply"},
            "model_b_dataset": {"compute_path": "input/b.pcd"},
        }
        def exists(path: Path) -> bool:
            return path.as_posix().endswith(("model-a-points.bin", "model-b-points.bin", "input/b.pcd"))
        with patch.object(Path, "is_file", autospec=True, side_effect=exists), patch.object(Path, "mkdir"):
            response = await self.resume()
        self.assertEqual(response["status"], "queued")
        self.start.assert_called_once()

    async def test_missing_source_rejects_resume(self):
        self.available.return_value = False
        with self.assertRaises(HTTPException) as error:
            await self.resume()
        self.assertEqual(error.exception.status_code, 409)
        self.start.assert_not_called()

    async def test_other_workspace_cannot_resume(self):
        self.status["workspace_id"] = "other"
        with self.assertRaises(HTTPException) as error:
            await self.resume()
        self.assertEqual(error.exception.status_code, 404)
        self.start.assert_not_called()

    async def test_preview_file_mapping_and_gaussian_guard(self):
        endpoint = self.routes["get_model_registration_preview"]
        with patch.object(Path, "is_file", return_value=True):
            response = await endpoint("session", "model-a")
            self.assertEqual(response.filename, "model-a-points.bin")
            self.assertEqual(response.path, Path("runtime/manual-sessions/session/preview/model-a-points.bin"))
            with self.assertRaises(HTTPException) as error:
                await endpoint("session", "gaussian-a")
            self.assertEqual(error.exception.status_code, 404)

    async def test_lcc_streamed_cache_is_explicit_and_idempotent(self):
        self.status["inputs"] = {
            "model_a_dataset": {"format": "lcc", "gaussian_cache_status": "not_requested"},
        }
        endpoint = self.routes["create_gaussian_cache"]
        first = await endpoint("session", "a")
        self.assertEqual(first, {"model": "a", "status": "queued"})
        self.start_cache.assert_called_once_with("session", "a")
        self.assertEqual(self.status["inputs"]["model_a_dataset"]["gaussian_cache_status"], "queued")

    async def test_failed_compressed_ply_cache_can_be_retried(self):
        self.status["inputs"] = {
            "model_b_dataset": {"format": "compressed_ply", "gaussian_cache_status": "failed"},
        }
        response = await self.routes["create_gaussian_cache"]("session", "b")
        self.assertEqual(response, {"model": "b", "status": "queued"})
        self.start_cache.assert_called_once_with("session", "b")
