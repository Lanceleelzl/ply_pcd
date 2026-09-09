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
        self.available = Mock(return_value=True)
        self.write = Mock(side_effect=lambda _, value: self.status.update(value))
        router = create_session_router(
            lambda _: Path("runtime/manual-sessions/session"), lambda _: Path("runtime/jobs/job"),
            lambda _: dict(self.status), self.write, self.available, lambda value: value,
            Mock(), Mock(), Mock(), 24, "worker", self.start,
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
        command = self.start.call_args.args[1]
        self.assertEqual(command[:2], ["worker", "prepare-model-preview"])
        self.assertNotIn("error", self.write.call_args.args[1])

    async def test_ready_preview_does_not_start_worker(self):
        self.status["status"] = "ready"
        with patch.object(Path, "is_file", return_value=True):
            response = await self.resume()
        self.assertEqual(response["status"], "ready")
        self.start.assert_not_called()

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
