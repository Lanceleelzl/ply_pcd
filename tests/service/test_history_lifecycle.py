import json
import tempfile
import time
import unittest
import uuid
from pathlib import Path

from service import app as service


IDENTITY = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]]


class HistoryLifecycleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.previous_runtime = service.RUNTIME_ROOT
        service.RUNTIME_ROOT = Path(self.temporary.name)
        self.workspace_id = str(uuid.uuid4())
        self.session_id = str(uuid.uuid4())
        self.job_id = str(uuid.uuid4())
        self.session_directory = service._manual_session_directory(self.session_id)
        input_directory = self.session_directory / "input"
        preview_directory = self.session_directory / "preview"
        input_directory.mkdir(parents=True)
        preview_directory.mkdir()
        (input_directory / "model-a.ply").write_bytes(b"ply-a")
        (input_directory / "model-b.pcd").write_bytes(b"pcd-b")
        (preview_directory / "model-a-points.bin").write_bytes(b"preview")
        (preview_directory / "model-b-points.bin").write_bytes(b"preview")

        now = time.time()
        self.status = {
            "session_id": self.session_id,
            "api_version": "v2",
            "workspace_id": self.workspace_id,
            "status": "ready",
            "created_at_unix": now - 10,
            "source_expires_at_unix": now + 86400,
            "model_a_filename": "model-a.ply",
            "model_b_filename": "model-b.pcd",
            "inputs": {
                "model_a_original_filename": "scene.ply", "model_b_original_filename": "map.pcd",
                "model_a_format": "ply", "model_b_format": "pcd",
                "model_a_bytes": 5, "model_b_bytes": 5,
                "model_a_sha256": "a" * 64, "model_b_sha256": "b" * 64,
            },
            "metadata": {"models": {"a": {"source_point_count": 100}, "b": {"source_point_count": 80}}},
            "registrations": [{
                "job_id": self.job_id, "status": "succeeded", "finished_at_unix": now,
                "output_direction": "a_to_b", "moving_model": "b",
                "parameters": {"sampling_limit": 50000},
            }],
        }
        service._write_status(self.session_directory, self.status)
        result_directory = service._job_directory(self.job_id) / "result"
        result_directory.mkdir(parents=True)
        service._write_status(result_directory.parent, {"job_id": self.job_id, "status": "succeeded"})
        (result_directory / "registration.json").write_text(json.dumps({
            "recommended_matrix": {"name": "T_a_to_b", "value": IDENTITY},
            "a_to_b": IDENTITY, "b_to_a": IDENTITY,
            "metrics": {"final_rms": 0.01, "final_point_count": 50000},
        }), encoding="utf-8")

    def tearDown(self) -> None:
        service.RUNTIME_ROOT = self.previous_runtime
        self.temporary.cleanup()

    def test_archive_survives_source_release(self) -> None:
        record = service._write_v2_history(self.session_directory, self.status)
        self.assertEqual(record["recommended_matrix"]["value"], IDENTITY)
        self.assertTrue(service._history_view(record)["restartable"])

        service._release_v2_source_data(self.session_directory, self.status)

        archived = json.loads(service._history_path(self.workspace_id, self.session_id).read_text(encoding="utf-8"))
        self.assertEqual(archived["a_to_b"], IDENTITY)
        self.assertFalse(service._history_view(archived)["restartable"])
        self.assertFalse((self.session_directory / "input").exists())
        self.assertFalse(service._job_directory(self.job_id).exists())

    def test_history_is_isolated_by_workspace(self) -> None:
        service._write_v2_history(self.session_directory, self.status)
        another_workspace = str(uuid.uuid4())
        self.assertTrue(service._history_path(self.workspace_id, self.session_id).is_file())
        self.assertFalse(service._history_path(another_workspace, self.session_id).is_file())

    def test_business_matrices_survive_source_release(self) -> None:
        path = service._job_directory(self.job_id) / "result" / "registration.json"
        result = json.loads(path.read_text(encoding="utf-8"))
        parameters = {"translation": [2, 3, 4], "rotation_degrees": [-90, 0, 0], "scale": [1, 2, 3]}
        result.update(file_a_to_b=IDENTITY, file_b_to_a=IDENTITY,
                      business_transforms={"a": {"parameters": parameters, "matrix": service._transform_matrix(parameters)}})
        path.write_text(json.dumps(result), encoding="utf-8")
        service._write_v2_history(self.session_directory, self.status)
        service._release_v2_source_data(self.session_directory, self.status)
        archived = json.loads(service._history_path(self.workspace_id, self.session_id).read_text(encoding="utf-8"))
        self.assertEqual(archived["business_transforms"], result["business_transforms"])
        self.assertEqual(archived["file_a_to_b"], IDENTITY)
        self.assertEqual(archived["a_to_b"], result["a_to_b"])

    def test_release_rejects_active_registration(self) -> None:
        self.status["active_job_id"] = self.job_id
        service._write_status(service._job_directory(self.job_id), {
            "job_id": self.job_id, "status": "running",
        })
        with self.assertRaises(service.HTTPException) as raised:
            service._release_v2_source_data(self.session_directory, self.status)
        self.assertEqual(raised.exception.status_code, 409)
        self.assertTrue((self.session_directory / "input" / "model-a.ply").is_file())


if __name__ == "__main__":
    unittest.main()
