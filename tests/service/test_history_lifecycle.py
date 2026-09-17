import asyncio
import json
import tempfile
import time
import unittest
import uuid
import zipfile
from io import BytesIO
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
        (self.session_directory / "datasets" / "model-a").mkdir(parents=True)
        (self.session_directory / "datasets" / "model-a" / "meta.json").write_text("{}", encoding="utf-8")
        (self.session_directory / "computed").mkdir()
        (self.session_directory / "computed" / "model-a.ply").write_bytes(b"computed")

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
        self.assertFalse((self.session_directory / "preview").exists())
        self.assertFalse((self.session_directory / "datasets").exists())
        self.assertFalse((self.session_directory / "computed").exists())
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

    def test_ready_stream_cache_is_listed_downloaded_and_removed_with_source(self) -> None:
        cache_directory = self.session_directory / "datasets" / "model-a-streamed"
        (cache_directory / "lod-0").mkdir(parents=True)
        (cache_directory / "lod-meta.json").write_text('{"type":"streamed-sog"}', encoding="utf-8")
        (cache_directory / "lod-0" / "chunk.sog").write_bytes(b"cache")
        self.status["inputs"]["model_a_dataset"] = {
            "gaussian_cache_status": "ready",
            "gaussian_cache_path": "datasets/model-a-streamed/lod-meta.json",
        }
        service._write_status(self.session_directory, self.status)
        record = service._write_v2_history(self.session_directory, self.status)

        view = service._history_view(record)
        self.assertTrue(view["stream_caches"]["a"]["available"])
        self.assertFalse(view["stream_caches"]["b"]["available"])

        endpoint = next(
            route.endpoint for route in service.app.routes
            if getattr(route, "path", "") == "/api/v2/registration-history/{session_id}/stream-cache/{model}"
        )
        response = asyncio.run(endpoint(self.session_id, "a", self.workspace_id))

        async def read_body() -> bytes:
            return b"".join([chunk async for chunk in response.body_iterator])

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.media_type, "application/zip")
        disposition = response.headers["content-disposition"]
        self.assertRegex(disposition, r"filename\*=UTF-8''scene-streamed-sog-\d{8}-\d{6}\.zip")
        self.assertEqual(response.headers["x-cache-file-count"], "2")
        self.assertEqual(response.headers["x-cache-source-bytes"], "28")
        with zipfile.ZipFile(BytesIO(asyncio.run(read_body()))) as archive:
            self.assertEqual(archive.read("lod-0/chunk.sog"), b"cache")
            self.assertEqual(archive.read("lod-meta.json"), b'{"type":"streamed-sog"}')
            self.assertIn("cache-manifest.json", archive.namelist())

        service._release_v2_source_data(self.session_directory, self.status)
        archived = json.loads(service._history_path(self.workspace_id, self.session_id).read_text(encoding="utf-8"))
        self.assertFalse(service._history_view(archived)["stream_caches"]["a"]["available"])

    def test_session_without_icp_is_listed_and_its_stream_cache_can_be_downloaded(self) -> None:
        session_id = str(uuid.uuid4())
        directory = service._manual_session_directory(session_id)
        (directory / "input").mkdir(parents=True)
        (directory / "input" / "model-a.ply").write_bytes(b"ply-a")
        (directory / "input" / "model-b.ply").write_bytes(b"ply-b")
        cache_directory = directory / "datasets" / "model-a-streamed"
        (cache_directory / "lod-0").mkdir(parents=True)
        (cache_directory / "lod-meta.json").write_text('{"type":"streamed-sog"}', encoding="utf-8")
        (cache_directory / "lod-0" / "chunk.sog").write_bytes(b"cache")
        now = time.time()
        service._write_status(directory, {
            "session_id": session_id,
            "api_version": "v2",
            "workspace_id": self.workspace_id,
            "owner_id": "anonymous",
            "status": "ready",
            "created_at_unix": now,
            "source_expires_at_unix": now + 86400,
            "model_a_filename": "model-a.ply",
            "model_b_filename": "model-b.ply",
            "output_direction": "a_to_b",
            "moving_model": "auto",
            "inputs": {
                "model_a_original_filename": "new-model.ply",
                "model_b_original_filename": "reference.ply",
                "model_a_format": "compressed_ply",
                "model_b_format": "ply",
                "model_a_bytes": 5,
                "model_b_bytes": 5,
                "model_a_dataset": {
                    "gaussian_cache_status": "ready",
                    "gaussian_cache_path": "datasets/model-a-streamed/lod-meta.json",
                },
            },
            "registrations": [],
        })

        list_endpoint = next(
            route.endpoint for route in service.app.routes
            if getattr(route, "path", "") == "/api/v2/registration-history"
        )
        response = asyncio.run(list_endpoint(self.workspace_id))
        item = next(item for item in response["items"] if item["session_id"] == session_id)
        self.assertFalse(item["has_registration_result"])
        self.assertTrue(item["restartable"])
        self.assertTrue(item["stream_caches"]["a"]["available"])

        download_endpoint = next(
            route.endpoint for route in service.app.routes
            if getattr(route, "path", "") == "/api/v2/registration-history/{session_id}/stream-cache/{model}"
        )
        download = asyncio.run(download_endpoint(session_id, "a", self.workspace_id))

        async def read_body() -> bytes:
            return b"".join([chunk async for chunk in download.body_iterator])

        with zipfile.ZipFile(BytesIO(asyncio.run(read_body()))) as archive:
            self.assertEqual(archive.read("lod-0/chunk.sog"), b"cache")


if __name__ == "__main__":
    unittest.main()
