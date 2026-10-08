import asyncio
import io
import json
import tempfile
import unittest
import uuid
import zipfile
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi import HTTPException, UploadFile

from service.routes.streaming import StreamingTasks, create_streaming_resource_router, create_streaming_router
from service.storage import read_status, write_status
from service.streaming_tasks import generate_streaming_cache


FIXTURE = Path(__file__).parent / "gaussian-small-binary.ply"


def write_streamed_cache(directory):
    chunk = directory / "0_0"
    chunk.mkdir(parents=True)
    (directory / "lod-meta.json").write_text(json.dumps({
        "lodLevels": 1, "filenames": ["0_0/meta.json"],
        "tree": {"bound": {}, "lods": {"0": {"file": 0, "offset": 0, "count": 1}}},
    }), encoding="utf-8")
    (chunk / "meta.json").write_text(json.dumps({
        "version": 2, "count": 1, "means": {"files": ["means.webp"]},
    }), encoding="utf-8")
    (chunk / "means.webp").write_bytes(b"means")


class StreamingTaskRoutesTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.tasks = StreamingTasks(Path(self.temporary.name), ["node", "converter"], "worker", 24)
        self.tasks.start = Mock()
        router = create_streaming_router(self.tasks)
        self.routes = {route.name: route.endpoint for route in router.routes}
        self.resource = create_streaming_resource_router(self.tasks).routes[0].endpoint
        self.workspace = str(uuid.uuid4())

    async def asyncTearDown(self):
        self.temporary.cleanup()

    async def test_original_ply_coordinate_metadata_is_available_before_preparation(self):
        data = FIXTURE.read_bytes().replace(b"end_header", b"comment epsg 32651\ncomment offsetx 260137.0225660622527357\ncomment source L2Pro\nend_header", 1)
        result = await self.routes["create_task"]("single", self.workspace,
            UploadFile(filename="scene.ply", file=io.BytesIO(data)), None, "")
        metadata = self.routes["coordinate_metadata"](result["task_id"])
        self.assertEqual(metadata["epsg"], "32651")
        self.assertEqual(metadata["offset"][0], "260137.0225660622527357")
        self.assertEqual(metadata["offset"][1:], [None, None])
        self.assertNotIn(result["task_id"], self.tasks.readers)

    async def test_ordered_lod_group_is_independent_of_registration_session(self):
        detailed = FIXTURE.read_bytes()
        head, body = detailed.split(b"end_header\n", 1)
        coarse = head.replace(b"element vertex 4", b"element vertex 3") + b"end_header\n" + body[:len(body) * 3 // 4]
        uploads = [UploadFile(filename="point_cloud.ply", file=io.BytesIO(detailed)),
                   UploadFile(filename="point_cloud_1.ply", file=io.BytesIO(coarse))]
        result = await self.routes["create_task"]("lod_group", self.workspace, None, uploads, "")
        directory, status = self.tasks.read(result["task_id"])
        self.assertEqual(directory.parent.name, "streaming-tasks")
        self.assertEqual([item["name"] for item in status["lods"]], ["point_cloud.ply", "point_cloud_1.ply"])
        self.assertEqual([item["level"] for item in status["lods"]], [0, 1])
        self.assertEqual(status["status"], "queued")
        self.assertTrue((directory / "input" / "lod-1.ply").is_file())
        self.tasks.start.assert_called_once_with(result["task_id"], "prepare")
        returned = await self.routes["list_tasks"](self.workspace)
        self.assertEqual(len(returned), 1)
        self.assertEqual(await self.routes["list_tasks"](str(uuid.uuid4())), [])

    async def test_duplicate_lod_is_rejected_without_persisting_task(self):
        data = FIXTURE.read_bytes()
        uploads = [UploadFile(filename=name, file=io.BytesIO(data)) for name in ("a.ply", "b.ply")]
        with self.assertRaises(HTTPException) as caught:
            await self.routes["create_task"]("lod_group", self.workspace, None, uploads, "")
        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(list(self.tasks.root.iterdir()), [])
        self.tasks.start.assert_not_called()

    async def test_resource_token_cannot_expose_status_or_leave_task(self):
        task_id = str(uuid.uuid4())
        directory = self.tasks.directory(task_id)
        source = directory / "input" / "model.ply"
        source.parent.mkdir(parents=True)
        source.write_bytes(FIXTURE.read_bytes())
        write_status(directory, {"task_id": task_id, "owner_id": "anonymous", "resource_token": "secret"})
        response = await self.resource(task_id, "secret", "input/model.ply")
        self.assertEqual(Path(response.path), source)
        for token, path in (("wrong", "input/model.ply"), ("secret", "status.json"),
                            ("secret", "../status.json"), ("secret", "input/../status.json"),
                            ("secret", "input/..\\status.json")):
            with self.subTest(path=path):
                with self.assertRaises(HTTPException) as caught:
                    await self.resource(task_id, token, path)
                self.assertEqual(caught.exception.status_code, 404)

    async def test_lcc_binary_companion_is_available(self):
        task_id = str(uuid.uuid4())
        directory = self.tasks.directory(task_id)
        source = directory / "datasets" / "scene" / "data.bin"
        source.parent.mkdir(parents=True)
        source.write_bytes(b"lcc-data")
        write_status(directory, {"task_id": task_id, "owner_id": "anonymous", "resource_token": "secret"})
        response = await self.resource(task_id, "secret", "datasets/scene/data.bin")
        self.assertEqual(Path(response.path), source)

    async def test_recovery_reuses_complete_output_before_cache_path_was_saved(self):
        task_id = str(uuid.uuid4())
        directory = self.tasks.directory(task_id)
        write_streamed_cache(directory / "output")
        write_status(directory, {"task_id": task_id, "status": "ready", "cache_status": "converting"})
        self.tasks.recover()
        self.tasks.start.assert_not_called()
        recovered = read_status(directory)
        self.assertEqual(recovered["cache_status"], "ready")
        self.assertEqual(recovered["cache_path"], "output/lod-meta.json")

    async def test_recovery_requeues_incomplete_output(self):
        task_id = str(uuid.uuid4())
        directory = self.tasks.directory(task_id)
        (directory / "output").mkdir(parents=True)
        (directory / "output/lod-meta.json").write_text('{"lodLevels": 1}', encoding="utf-8")
        write_status(directory, {"task_id": task_id, "status": "ready", "cache_status": "converting"})
        self.tasks.recover()
        self.tasks.start.assert_called_once_with(task_id, "generate")

    async def test_release_preserves_reused_input_cache(self):
        task_id = str(uuid.uuid4())
        directory = self.tasks.directory(task_id)
        write_streamed_cache(directory / "datasets" / "source")
        status = {"task_id": task_id, "owner_id": "anonymous", "resource_token": "secret",
                  "status": "ready", "cache_status": "ready", "cache_path": "datasets/source/lod-meta.json",
                  "filename": "scene.zip", "source_available": True}
        write_status(directory, status)
        released = await self.routes["release"](task_id)
        self.assertFalse(released["source_available"])
        self.assertTrue((directory / released["cache_path"]).is_file())
        response = await self.routes["download"](task_id)
        chunks = [chunk async for chunk in response.body_iterator]
        with zipfile.ZipFile(io.BytesIO(b"".join(chunks))) as archive:
            self.assertEqual(archive.read("0_0/means.webp"), b"means")

    async def test_reused_streamed_input_is_materialized_in_output(self):
        directory = self.tasks.directory(str(uuid.uuid4()))
        write_streamed_cache(directory / "datasets" / "source")
        status = {"input_kind": "dataset", "format": "streamed_sog",
                  "dataset_entrypoint": "datasets/source/lod-meta.json"}
        result = generate_streaming_cache(directory, status, ["node", "converter"])
        self.assertEqual(result, "output/lod-meta.json")
        self.assertEqual((directory / "output/0_0/means.webp").read_bytes(), b"means")

    async def test_resource_readers_protect_release_until_all_responses_finish(self):
        task_id = str(uuid.uuid4())
        directory = self.tasks.directory(task_id)
        (directory / "input").mkdir(parents=True)
        (directory / "input/model.ply").write_bytes(FIXTURE.read_bytes())
        (directory / "preview").mkdir()
        (directory / "preview/model-points.bin").write_bytes(b"preview")
        write_streamed_cache(directory / "output")
        write_status(directory, {"task_id": task_id, "owner_id": "anonymous", "resource_token": "secret",
                                 "status": "ready", "cache_status": "ready", "filename": "scene.ply",
                                 "cache_path": "output/lod-meta.json"})
        responses = [await self.resource(task_id, "secret", "input/model.ply"),
                     await self.routes["preview"](task_id), await self.routes["download"](task_id)]
        started = [asyncio.Event() for _ in responses]
        finish = [asyncio.Event() for _ in responses]

        async def send(index, message):
            if message["type"] == "http.response.start":
                started[index].set()
                await finish[index].wait()

        pending = [asyncio.create_task(response({"type": "http", "method": "GET", "headers": [],
                                                "asgi": {"spec_version": "2.4"}},
                                               None, lambda message, index=index: send(index, message)))
                   for index, response in enumerate(responses)]
        try:
            await asyncio.wait_for(asyncio.gather(*(event.wait() for event in started)), 3)
            with self.assertRaises(HTTPException) as caught:
                await self.routes["release"](task_id)
            self.assertEqual(caught.exception.status_code, 409)
            finish[0].set()
            await pending[0]
            with self.assertRaises(HTTPException):
                await self.routes["release"](task_id)
            finish[1].set()
            await pending[1]
            with self.assertRaises(HTTPException):
                await self.routes["release"](task_id)
            finish[2].set()
            await pending[2]
            self.assertNotIn(task_id, self.tasks.readers)
            await self.routes["release"](task_id)
        finally:
            for event in finish:
                event.set()
            await asyncio.gather(*pending, return_exceptions=True)

    async def test_failed_download_releases_reader(self):
        task_id = str(uuid.uuid4())
        directory = self.tasks.directory(task_id)
        write_streamed_cache(directory / "output")
        write_status(directory, {"task_id": task_id, "owner_id": "anonymous", "resource_token": "secret",
                                 "status": "ready", "cache_status": "ready", "filename": "scene.ply",
                                 "cache_path": "output/lod-meta.json"})
        response = await self.routes["download"](task_id)

        async def send(message):
            self.assertIn(task_id, self.tasks.readers)
            raise RuntimeError("connection lost")

        with self.assertRaisesRegex(RuntimeError, "connection lost"):
            await response({"type": "http", "method": "GET", "headers": [],
                            "asgi": {"spec_version": "2.4"}}, None, send)
        self.assertNotIn(task_id, self.tasks.readers)

    async def test_ready_cache_is_reused_and_failed_cache_can_retry(self):
        task_id = str(uuid.uuid4())
        directory = self.tasks.directory(task_id)
        directory.mkdir(parents=True)
        status = {"task_id": task_id, "owner_id": "anonymous", "workspace_id": self.workspace,
                  "resource_token": "secret", "status": "ready", "cache_status": "ready",
                  "cache_path": "output/lod-meta.json"}
        write_status(directory, status)
        with patch("service.routes.streaming.validate_streamed_sog_directory") as validate:
            response = await self.routes["generate"](task_id)
        self.assertEqual(response["cache_status"], "ready")
        validate.assert_called_once()
        self.tasks.start.assert_not_called()
        status = read_status(directory)
        status["cache_status"] = "failed"
        write_status(directory, status)
        response = await self.routes["generate"](task_id)
        self.assertEqual(response["cache_status"], "queued")
        self.tasks.start.assert_called_once_with(task_id, "generate")

    async def test_download_streams_cache_with_checksum_manifest_and_releases_reader(self):
        task_id = str(uuid.uuid4())
        directory = self.tasks.directory(task_id)
        output = directory / "output"
        output.mkdir(parents=True)
        (output / "lod-meta.json").write_text(json.dumps({"lodLevels": 1}), encoding="utf-8")
        (output / "chunk.webp").write_bytes(b"streamed-sog-test")
        write_status(directory, {"task_id": task_id, "owner_id": "anonymous", "workspace_id": self.workspace,
                                 "resource_token": "secret", "status": "ready", "cache_status": "ready",
                                 "cache_path": "output/lod-meta.json", "filename": "scene.ply"})
        response = await self.routes["download"](task_id)
        chunks = [chunk async for chunk in response.body_iterator]
        self.assertNotIn(task_id, self.tasks.readers)
        with zipfile.ZipFile(io.BytesIO(b"".join(chunks))) as archive:
            self.assertIsNone(archive.testzip())
            self.assertIn("lod-meta.json", archive.namelist())
            manifest_name = next(name for name in archive.namelist() if "manifest" in name)
            manifest = json.loads(archive.read(manifest_name))
            self.assertEqual({item["path"] for item in manifest["files"]}, {"chunk.webp", "lod-meta.json"})

    async def test_expired_cleanup_preserves_output_and_skips_active_task(self):
        task_id = str(uuid.uuid4())
        directory = self.tasks.directory(task_id)
        for name in ("input", "datasets", "computed", "preview", "output"):
            (directory / name).mkdir(parents=True, exist_ok=True)
            (directory / name / "kept-or-released.bin").write_bytes(b"test")
        status = {"task_id": task_id, "owner_id": "anonymous", "workspace_id": self.workspace,
                  "resource_token": "secret", "status": "ready", "cache_status": "ready",
                  "cache_path": "output/lod-meta.json", "gaussian_path": "input/model.ply",
                  "preview_url": f"/api/v2/streaming-tasks/{task_id}/preview",
                  "source_available": True, "source_expires_at_unix": 10}
        write_status(directory, status)
        self.tasks.readers[task_id] = 1
        self.tasks.cleanup_expired(now=20)
        self.assertTrue((directory / "input").is_dir())
        self.tasks.readers.pop(task_id)
        self.tasks.cleanup_expired(now=20)
        for name in ("input", "datasets", "computed", "preview"):
            self.assertFalse((directory / name).exists())
        self.assertTrue((directory / "output" / "kept-or-released.bin").is_file())
        released = read_status(directory)
        self.assertFalse(released["source_available"])
        self.assertIsNone(released["source_expires_at_unix"])
        self.assertIsNone(released["gaussian_path"])

    async def test_retain_and_release_endpoints_protect_active_generation(self):
        task_id = str(uuid.uuid4())
        directory = self.tasks.directory(task_id)
        (directory / "input").mkdir(parents=True)
        status = {"task_id": task_id, "owner_id": "anonymous", "workspace_id": self.workspace,
                  "resource_token": "secret", "status": "ready", "cache_status": "not_requested",
                  "source_available": True, "source_expires_at_unix": 1}
        write_status(directory, status)
        retained = await self.routes["retain"](task_id)
        self.assertGreater(retained["source_expires_at_unix"], 1)
        self.tasks.running[task_id] = Mock(done=Mock(return_value=False))
        with self.assertRaises(HTTPException) as caught:
            await self.routes["release"](task_id)
        self.assertEqual(caught.exception.status_code, 409)
        self.tasks.running.clear()
        released = await self.routes["release"](task_id)
        self.assertFalse(released["source_available"])
