import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from service.routes.coarse_registrations import create_coarse_registration_router
from service.schemas import CoarseRegistrationRequest


class CoarseRegistrationRouteTest(unittest.IsolatedAsyncioTestCase):
    async def test_creates_separate_owned_job_and_serves_candidate_result(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            session_directory = root / "sessions" / "session"
            (session_directory / "input").mkdir(parents=True)
            for name in ("a.ply", "b.ply"):
                (session_directory / "input" / name).write_text("source", encoding="utf-8")
            statuses = {
                str(session_directory): {
                    "api_version": "v2", "status": "ready", "owner_id": "owner",
                    "model_a_filename": "a.ply", "model_b_filename": "b.ply",
                    "business_transforms": {
                        "a": {"translation": [0, 0, 0], "rotation_degrees": [0, 0, 0], "scale": [1, 1, 1]},
                        "b": {"translation": [0, 0, 0], "rotation_degrees": [0, 0, 0], "scale": [1, 1, 1]},
                    },
                }
            }

            def job_directory(job_id):
                return root / "jobs" / job_id

            def read_status(directory):
                return dict(statuses[str(directory)])

            def write_status(directory, status):
                statuses[str(directory)] = dict(status)

            started = Mock()
            router = create_coarse_registration_router(
                lambda _: session_directory, job_directory, read_status, write_status,
                lambda *_: True, lambda *_: True, __import__("asyncio").Lock(), "worker",
                lambda directory, command: (directory / "task.json").write_text(json.dumps(command), encoding="utf-8"),
                started, Mock(), {},
            )
            endpoints = {route.name: route.endpoint for route in router.routes}
            created = await endpoints["create_coarse_registration"](
                "session", CoarseRegistrationRequest(moving_model="a")
            )
            job_id = created["job_id"]
            command = started.call_args.args[1]
            self.assertEqual(command[1], "coarse-register-models")
            self.assertIn("--model-a-to-business", command)
            self.assertEqual(statuses[str(job_directory(job_id))]["job_type"], "coarse_registration")
            self.assertEqual(statuses[str(session_directory)]["active_job_id"], job_id)

            result_path = job_directory(job_id) / "result" / "coarse-registration.json"
            result_path.parent.mkdir(exist_ok=True)
            result_path.write_text(json.dumps({"algorithm": "cccorelib_4pcs"}), encoding="utf-8")
            statuses[str(job_directory(job_id))]["status"] = "succeeded"
            result = await endpoints["get_coarse_registration_result"](job_id)
            self.assertEqual(result["algorithm"], "cccorelib_4pcs")

    async def test_rejects_invalid_parameters_before_creating_job(self):
        router = create_coarse_registration_router(
            Mock(), Mock(), Mock(), Mock(), Mock(), Mock(), __import__("asyncio").Lock(),
            "worker", Mock(), Mock(), Mock(), {},
        )
        endpoint = {route.name: route.endpoint for route in router.routes}["create_coarse_registration"]
        with self.assertRaises(Exception) as raised:
            await endpoint("session", CoarseRegistrationRequest(moving_model="auto"))
        self.assertEqual(raised.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
