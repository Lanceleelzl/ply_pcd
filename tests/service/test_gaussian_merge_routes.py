import asyncio
import io
import json
import math
import struct
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from fastapi import UploadFile
from fastapi import HTTPException

from service.routes.gaussian_merge import MergeCancelled, MergeTasks, create_merge_router, create_merge_resource_router, restore_completed_merge, validate_merged_levels
from service.gaussian_merge import read_layout
from service.storage import write_status


def gaussian(name, offset, geo=True, point=(0, 0, 0)):
    header = ("ply\nformat binary_little_endian 1.0\n" +
              (f"comment epsg 32650\ncomment offsetx {offset}\ncomment offsety 2000\ncomment offsetz 10\n"
               if geo else "") +
              "element vertex 1\nproperty float x\nproperty float y\nproperty float z\n"
              "property float scale_0\nproperty float scale_1\nproperty float scale_2\n"
              "property float opacity\nproperty float f_dc_0\nproperty float f_dc_1\n"
              "property float f_dc_2\nproperty float rot_0\nproperty float rot_1\n"
              "property float rot_2\nproperty float rot_3\nend_header\n").encode("ascii")
    values = (*point, 1, 1, 1, 0.5, 0, 0, 0, 1, 0, 0, 0)
    return UploadFile(filename=name, file=io.BytesIO(header + struct.pack("<14f", *values)))


class MergeRouteTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.tasks = MergeTasks(Path(self.temporary.name), ["node", "converter"])
        self.routes = {route.name: route.endpoint for route in create_merge_router(self.tasks).routes}
        self.resource_routes = {route.name: route.endpoint for route in create_merge_resource_router(self.tasks).routes}

    async def asyncTearDown(self):
        self.temporary.cleanup()

    async def test_cancel_running_merge_does_not_recover(self):
        status = await self.routes["create_merge"](str(uuid.uuid4()), "[1,1]", [
            gaussian("a.ply", 1000), gaussian("b.ply", 1004)])
        task_id = status["task_id"]
        directory = self.tasks.directory(task_id)
        status = self.tasks.read(task_id)[1]
        status["units_confirmed"] = True
        write_status(directory, status)
        def wait_for_cancel(_directory, _status):
            while not self.tasks.cancellations[task_id].wait(0.01):
                pass
            raise MergeCancelled()

        with patch.object(self.tasks, "_merge", side_effect=wait_for_cancel):
            await self.routes["start_merge"](task_id)
            while self.tasks.read(task_id)[1]["merge_status"] != "running":
                await asyncio.sleep(0.01)
            cancelled = await self.routes["cancel_merge"](task_id)
            self.assertEqual(cancelled["merge_status"], "cancelling")
            await asyncio.wait_for(self.tasks.running[task_id], 5)
        result = self.tasks.read(task_id)[1]
        self.assertEqual(result["merge_status"], "cancelled")
        self.assertTrue(all(item["status"] == "cancelled" for item in result["level_progress"]))
        self.tasks.recover()
        self.assertNotIn(task_id, self.tasks.running)

    async def test_coordinate_preview_converts_projected_origin(self):
        preview = self.routes["coordinate_preview"](32651, 500000, 0, 13.5)
        self.assertAlmostEqual(preview["wgs84"][0], 123, places=7)
        self.assertAlmostEqual(preview["wgs84"][1], 0, places=7)
        self.assertEqual(preview["wgs84"][2], 13.5)
        with self.assertRaises(HTTPException):
            self.routes["coordinate_preview"](4326, 123, 0, 13.5)

    async def test_boundary_coordinates_convert_both_directions(self):
        projected = self.routes["convert_coordinates"]({"epsg": "32651", "mode": "wgs84", "points": [[123, 0]]})
        self.assertAlmostEqual(projected["points"][0][0], 500000, places=5)
        geographic = self.routes["convert_coordinates"]({"epsg": "32651", "mode": "projected", "points": projected["points"]})
        self.assertAlmostEqual(geographic["points"][0][0], 123, places=7)
        with self.assertRaises(HTTPException):
            self.routes["convert_coordinates"]({"epsg": "32651", "mode": "wgs84", "points": [[181, 0]]})

    async def test_ready_streamed_cache_exposes_only_its_tokenized_files(self):
        created = await self.routes["create_merge"](str(uuid.uuid4()), "[1,1]", [
            gaussian("a.ply", 1000), gaussian("b.ply", 1004)])
        task_id = created["task_id"]
        directory = self.tasks.directory(task_id)
        status = self.tasks.read(task_id)[1]
        relative = "streamed/test-cache/lod-meta.json"
        cache_root = directory / "streamed" / "test-cache"
        cache_root.mkdir(parents=True)
        (cache_root / "lod-meta.json").write_text('{"lodLevels":1}', encoding="utf-8")
        (cache_root / "sh0.webp").write_bytes(b"webp")
        status.update(cache_status="ready", cache_path=relative)
        write_status(directory, status)
        url = self.routes["get_merge"](task_id)["cache_url"]
        self.assertEqual(url, f"/merge-resources/{task_id}/{status['resource_token']}/{relative}")
        resource = self.resource_routes["merge_resource"]
        response = resource(task_id, status["resource_token"], "streamed/test-cache/sh0.webp")
        self.assertEqual(Path(response.path).read_bytes(), b"webp")
        for token, path in [("wrong", relative),
                            (status["resource_token"], "streamed/other/lod-meta.json"),
                            (status["resource_token"], "streamed/test-cache/../../status.json")]:
            with self.assertRaises(HTTPException):
                resource(task_id, token, path)
        status["cache_status"] = "not_requested"
        write_status(directory, status)
        self.assertIsNone(self.routes["get_merge"](task_id)["cache_url"])
        with self.assertRaises(HTTPException):
            resource(task_id, status["resource_token"], relative)

    async def test_upload_preview_region_and_merge(self):
        status = await self.routes["create_merge"](str(uuid.uuid4()), "[1,1]", [
            gaussian("a.ply", 1000), gaussian("b.ply", 1004)])
        task_id = status["task_id"]
        preview = await self.routes["preview"](task_id)
        self.assertEqual(preview["models"], [[[0, 0, 0]], [[4, 0, 0]]])
        saved = self.routes["save_regions"](task_id, {"axes": [1, 2, 3], "units_confirmed": True,
            "corrections": [[0, 0, 0], [0, 0, 0]], "regions": [
                {"kind": "keep", "model": 0,
                 "polygon": [[-1, -1], [5, -1], [5, 1], [-1, 1]]}]})
        self.assertEqual(saved["merge_status"], "editing")
        await self.routes["start_merge"](task_id)
        await asyncio.wait_for(self.tasks.running[task_id], 5)
        result = self.tasks.read(task_id)[1]
        self.assertEqual(result["merge_status"], "ready")
        self.assertEqual(result["cache_status"], "not_requested")
        self.assertIsNone(result.get("cache_path"))
        self.assertEqual(result["merged_lods"][0]["count"], 1)
        response = self.routes["download"](task_id, "ply")
        self.assertIn("gaussian-merge-ply.zip", response.headers["content-disposition"])
        lod_response = self.routes["download_merged_lod"](task_id, 0)
        self.assertEqual(Path(lod_response.path).read_bytes(),
                         (self.tasks.directory(task_id) / result["merged_lods"][0]["path"]).read_bytes())
        self.assertIn("gaussian-merge-lod-0.ply", lod_response.headers["content-disposition"])
        with self.assertRaises(HTTPException):
            self.routes["download_merged_lod"](task_id, 1)
        with self.tasks.reading(task_id), self.assertRaises(HTTPException):
            await self.routes["start_merge"](task_id)

    async def test_registration_matrix_persists_and_drives_preview_and_merge(self):
        created = await self.routes["create_merge"](str(uuid.uuid4()), "[1,1]", [
            gaussian("known.ply", 1000), gaussian("unknown.ply", 9000, geo=False, point=(1, 0, 0))])
        task_id = created["task_id"]
        matrix = [[0, -1, 0, 5], [1, 0, 0, 7], [0, 0, 1, 0], [0, 0, 0, 1]]
        payload = {"axes": [1, 2, 3], "units_confirmed": True, "target_model": 0,
                   "corrections": [[0, 0, 0], [0, 0, 0]], "regions": [],
                   "registration_matrices": [None, matrix]}
        saved = self.routes["save_regions"](task_id, payload)
        self.assertEqual(saved["models"][1]["registration_matrix"], matrix)
        preview = await self.routes["preview"](task_id)
        self.assertEqual(preview["models"][1], [[5, 8, 0]])
        await self.routes["start_merge"](task_id)
        await asyncio.wait_for(self.tasks.running[task_id], 5)
        status = self.tasks.read(task_id)[1]
        layout = read_layout(self.tasks.directory(task_id) / status["merged_lods"][0]["path"])
        with layout.path.open("rb") as data:
            data.seek(layout.data_start + layout.stride)
            self.assertEqual(struct.unpack("<3f", data.read(12)), (5, 8, 0))
        with self.assertRaisesRegex(HTTPException, "配准矩阵只能作用于待合入模型"):
            self.routes["save_regions"](task_id, {**payload, "registration_matrices": [matrix, None]})

    async def test_restoring_original_regions_relinks_finished_merge_and_cache(self):
        created = await self.routes["create_merge"](str(uuid.uuid4()), "[1,1]", [
            gaussian("a.ply", 1000), gaussian("b.ply", 1004)])
        task_id = created["task_id"]
        directory = self.tasks.directory(task_id)
        status = self.tasks.read(task_id)[1]
        status["units_confirmed"] = True
        for model in status["models"]:
            model["confirmed"] = True
        write_status(directory, status)
        await self.routes["start_merge"](task_id)
        await asyncio.wait_for(self.tasks.running[task_id], 5)
        completed = self.tasks.read(task_id)[1]
        cache_path = "streamed/old/lod-meta.json"
        (directory / cache_path).parent.mkdir(parents=True)
        (directory / cache_path).write_text("{}", encoding="utf-8")
        completed.update(cache_status="ready", cache_path=cache_path)
        write_status(directory, completed)
        payload = {"regions": [{"kind": "per_model", "actions": ["none", "none"],
                                "polygon": [[0, 0], [1, 0], [0, 1]]}],
                   "corrections": [model["correction"] for model in completed["models"]],
                   "rotations": [model["rotation"] for model in completed["models"]],
                   "axes": completed["axes"], "units_confirmed": True}
        edited = self.routes["save_regions"](task_id, payload)
        self.assertEqual((edited["merge_status"], edited["cache_status"]), ("editing", "not_requested"))
        payload["regions"] = completed["regions"]
        with patch("service.routes.gaussian_merge.validate_streamed_sog_directory"):
            restored = self.routes["save_regions"](task_id, payload)
        self.assertEqual((restored["merge_status"], restored["cache_status"]), ("ready", "ready"))
        self.assertEqual(len(restored["merged_lods"]), 1)
        self.assertEqual(restored["cache_path"], cache_path)

    async def test_cancelled_replacement_restores_matching_completed_download(self):
        status = await self.routes["create_merge"](str(uuid.uuid4()), "[1,1]", [
            gaussian("a.ply", 1000), gaussian("b.ply", 1004)])
        task_id = status["task_id"]
        self.routes["save_regions"](task_id, {"axes": [1, 2, 3], "units_confirmed": True,
            "corrections": [[0, 0, 0], [0, 0, 0]], "regions": []})
        await self.routes["start_merge"](task_id)
        await asyncio.wait_for(self.tasks.running[task_id], 5)
        directory, original = self.tasks.read(task_id)
        original_path = original["merged_lods"][0]["path"]
        original["merge_status"] = "cancelled"
        original["merge_path"] = "merged/aborted"
        original["merged_lods"] = []
        original["level_progress"][0]["status"] = "cancelled"
        self.assertTrue(restore_completed_merge(directory, original))
        write_status(directory, original)
        self.assertEqual(original["merge_status"], "ready")
        self.assertEqual(Path(self.routes["download_merged_lod"](task_id, 0).path),
                         directory / original_path)
        original["regions"] = [{"kind": "per_model", "actions": ["remove_inside", "none"],
                                "polygon": [[0, 0], [1, 0], [0, 1]]}]
        self.assertFalse(restore_completed_merge(directory, original))

    async def test_cancel_repeated_merge_relinks_prior_result(self):
        status = await self.routes["create_merge"](str(uuid.uuid4()), "[1,1]", [
            gaussian("a.ply", 1000), gaussian("b.ply", 1004)])
        task_id = status["task_id"]
        self.routes["save_regions"](task_id, {"axes": [1, 2, 3], "units_confirmed": True,
            "corrections": [[0, 0, 0], [0, 0, 0]], "regions": []})
        await self.routes["start_merge"](task_id)
        await asyncio.wait_for(self.tasks.running[task_id], 5)
        original_path = self.tasks.read(task_id)[1]["merged_lods"][0]["path"]

        def wait_for_cancel(_directory, _status):
            while not self.tasks.cancellations[task_id].wait(0.01):
                pass
            raise MergeCancelled()

        with patch.object(self.tasks, "_merge", side_effect=wait_for_cancel):
            await self.routes["start_merge"](task_id)
            while self.tasks.read(task_id)[1]["merge_status"] != "running":
                await asyncio.sleep(0.01)
            await self.routes["cancel_merge"](task_id)
            await asyncio.wait_for(self.tasks.running[task_id], 5)
        restored = self.tasks.read(task_id)[1]
        self.assertEqual(restored["merge_status"], "ready")
        self.assertEqual(restored["merged_lods"][0]["path"], original_path)
        self.assertEqual(restored["level_progress"][0]["status"], "ready")

    async def test_same_region_applies_to_each_confirmed_lod(self):
        status = await self.routes["create_merge"](str(uuid.uuid4()), "[2,2]", [
            gaussian("a-0.ply", 1000), gaussian("a-1.ply", 1000),
            gaussian("b-0.ply", 1004), gaussian("b-1.ply", 1004)])
        task_id = status["task_id"]
        self.routes["save_regions"](task_id, {"axes": [1, 2, 3], "units_confirmed": True,
            "corrections": [[0, 0, 0], [0, 0, 0]], "regions": [
                {"kind": "keep", "model": 0,
                 "polygon": [[-1, -1], [5, -1], [5, 1], [-1, 1]]}]})
        await self.routes["start_merge"](task_id)
        await asyncio.wait_for(self.tasks.running[task_id], 5)
        result = self.tasks.read(task_id)[1]
        self.assertEqual([item["by_model"] for item in result["merged_lods"]], [[1, 0], [1, 0]])
        preview = await self.routes["preview_merged"](task_id, 1)
        self.assertEqual(preview["models"], [[[0, 0, 0]]])
        self.assertEqual((await self.routes["preview"](task_id, 0))["models"],
                         [[[0, 0, 0]], [[4, 0, 0]]])
        response = self.routes["source_lod"](task_id, 0, 0)
        self.assertEqual(response.media_type, "application/octet-stream")
        with self.assertRaises(HTTPException):
            self.routes["source_lod"](task_id, 5, 0)

    async def test_recovery_preserves_completed_lod(self):
        status = await self.routes["create_merge"](str(uuid.uuid4()), "[1,1]", [
            gaussian("a.ply", 1000), gaussian("b.ply", 1004)])
        task_id = status["task_id"]
        self.routes["save_regions"](task_id, {"axes": [1, 2, 3], "units_confirmed": True,
            "corrections": [[0, 0, 0], [0, 0, 0]], "regions": []})
        await self.routes["start_merge"](task_id)
        await asyncio.wait_for(self.tasks.running[task_id], 5)
        directory, completed = self.tasks.read(task_id)
        output = directory / completed["merged_lods"][0]["path"]
        original = output.read_bytes()
        with patch("service.routes.gaussian_merge.merge_level", side_effect=AssertionError("recomputed")):
            resumed = self.tasks._merge(directory, completed)
        self.assertEqual(resumed, completed["merged_lods"])
        self.assertEqual(output.read_bytes(), original)
        completed["merge_status"] = "running"
        completed["merged_lods"] = []
        write_status(directory, completed)
        self.assertTrue(self.routes["get_merge"](task_id)["partial_lod_downloads"])
        resumed_legacy = self.tasks._merge(directory, completed)
        self.assertEqual(resumed_legacy[0]["count"], read_layout(output).count)
        self.assertEqual(Path(self.routes["download_merged_lod"](task_id, 0).path), output)

    async def test_recovery_only_recomputes_unfinished_lod(self):
        status = await self.routes["create_merge"](str(uuid.uuid4()), "[2,2]", [
            gaussian("a-0.ply", 1000), gaussian("a-1.ply", 1000),
            gaussian("b-0.ply", 1004), gaussian("b-1.ply", 1004)])
        task_id = status["task_id"]
        self.routes["save_regions"](task_id, {"axes": [1, 2, 3], "units_confirmed": True,
            "corrections": [[0, 0, 0], [0, 0, 0]], "regions": []})
        await self.routes["start_merge"](task_id)
        await asyncio.wait_for(self.tasks.running[task_id], 5)
        directory, interrupted = self.tasks.read(task_id)
        first = directory / interrupted["merged_lods"][0]["path"]
        first_modified = first.stat().st_mtime_ns
        interrupted["merge_status"] = "running"
        interrupted["merged_lods"] = interrupted["merged_lods"][:1]
        interrupted["level_progress"][1]["status"] = "running"
        write_status(directory, interrupted)
        from service.routes.gaussian_merge import merge_level
        with patch("service.routes.gaussian_merge.merge_level", wraps=merge_level) as merge:
            resumed = self.tasks._merge(directory, interrupted)
        self.assertEqual(merge.call_count, 1)
        self.assertEqual([item["level"] for item in resumed], [0, 1])
        self.assertEqual(first.stat().st_mtime_ns, first_modified)

    async def test_selected_lod_merges_alone_and_reports_level_progress(self):
        status = await self.routes["create_merge"](str(uuid.uuid4()), "[2,2]", [
            gaussian("a-0.ply", 1000), gaussian("a-1.ply", 1000),
            gaussian("b-0.ply", 1004), gaussian("b-1.ply", 1004)])
        task_id = status["task_id"]
        self.routes["save_regions"](task_id, {"axes": [1, 2, 3], "units_confirmed": True,
            "corrections": [[0, 0, 0], [0, 0, 0]], "regions": []})
        await self.routes["start_merge"](task_id, {"levels": [1]})
        await asyncio.wait_for(self.tasks.running[task_id], 5)
        directory, result = self.tasks.read(task_id)
        self.assertEqual(result["merge_status"], "ready")
        self.assertEqual([item["level"] for item in result["merged_lods"]], [1])
        self.assertEqual([item["status"] for item in result["level_progress"]], ["not_selected", "ready"])
        self.assertEqual(validate_merged_levels(directory, result)[0]["level"], 1)
        self.assertEqual((await self.routes["preview_merged"](task_id, 1))["models"][0], [[0, 0, 0], [4, 0, 0]])

    async def test_completed_lod_remains_downloadable_during_remaining_lod_merge(self):
        created = await self.routes["create_merge"](str(uuid.uuid4()), "[2,2]", [
            gaussian("a-0.ply", 1000), gaussian("a-1.ply", 1000),
            gaussian("b-0.ply", 1004), gaussian("b-1.ply", 1004)])
        task_id = created["task_id"]
        self.routes["save_regions"](task_id, {"axes": [1, 2, 3], "units_confirmed": True,
            "corrections": [[0, 0, 0], [0, 0, 0]], "regions": []})
        await self.routes["start_merge"](task_id, {"levels": [0]})
        await asyncio.wait_for(self.tasks.running[task_id], 5)
        directory, completed = self.tasks.read(task_id)
        first = directory / completed["merged_lods"][0]["path"]
        first_modified = first.stat().st_mtime_ns

        # A previous service version cleared the result list when starting LOD 1.
        interrupted = dict(completed, merge_status="running", selected_levels=[1], merged_lods=[],
                           level_progress=[{"level": 0, "status": "not_selected"},
                                           {"level": 1, "status": "running"}])
        write_status(directory, interrupted)
        visible = self.routes["get_merge"](task_id)
        self.assertEqual(visible["level_progress"][0]["status"], "ready")
        self.assertEqual(visible["merged_lods"][0]["path"], completed["merged_lods"][0]["path"])
        self.assertEqual(Path(self.routes["download_merged_lod"](task_id, 0).path), first)
        write_status(directory, dict(interrupted, merge_status="editing", level_progress=[]))
        self.assertEqual(self.routes["get_merge"](task_id)["level_progress"][0]["status"], "ready")
        write_status(directory, dict(interrupted, merge_status="ready"))
        self.assertEqual((await self.routes["preview_merged"](task_id, 0))["models"][0], [[0, 0, 0], [4, 0, 0]])

        write_status(directory, completed)
        await self.routes["start_merge"](task_id, {"levels": [1]})
        await asyncio.wait_for(self.tasks.running[task_id], 5)
        result = self.tasks.read(task_id)[1]
        self.assertEqual([item["level"] for item in result["merged_lods"]], [0, 1])
        self.assertEqual([item["status"] for item in result["level_progress"]], ["ready", "ready"])
        self.assertEqual(first.stat().st_mtime_ns, first_modified)
        self.assertEqual([item["level"] for item in validate_merged_levels(directory, result)], [0, 1])
        self.assertEqual((await self.routes["preview_merged"](task_id, 0))["models"][0], [[0, 0, 0], [4, 0, 0]])
        with patch("service.routes.gaussian_merge.merge_level", side_effect=AssertionError("recomputed")):
            await self.routes["start_merge"](task_id, {"levels": [0, 1]})
            await asyncio.wait_for(self.tasks.running[task_id], 5)
        self.assertEqual(self.tasks.read(task_id)[1]["merge_status"], "ready")

    async def test_partial_failed_run_keeps_finished_lod_after_reentry_and_resume(self):
        created = await self.routes["create_merge"](str(uuid.uuid4()), "[2,2]", [
            gaussian("a-0.ply", 1000), gaussian("a-1.ply", 1000),
            gaussian("b-0.ply", 1004), gaussian("b-1.ply", 1004)])
        task_id = created["task_id"]
        self.routes["save_regions"](task_id, {"axes": [1, 2, 3], "units_confirmed": True,
            "corrections": [[0, 0, 0], [0, 0, 0]], "regions": []})
        from service.routes.gaussian_merge import merge_level as original_merge_level

        def fail_second(inputs, output, *args, **kwargs):
            if output.name == "lod-1.ply":
                raise ValueError("interrupted")
            return original_merge_level(inputs, output, *args, **kwargs)

        with patch("service.routes.gaussian_merge.merge_level", side_effect=fail_second):
            await self.routes["start_merge"](task_id, {"levels": [0, 1]})
            await asyncio.wait_for(self.tasks.running[task_id], 5)
        directory, failed = self.tasks.read(task_id)
        self.assertEqual(failed["merge_status"], "failed")
        partial_manifest = directory / failed["merge_path"] / "merge-manifest.json"
        self.assertFalse(json.loads(partial_manifest.read_text(encoding="utf-8"))["run_complete"])
        self.assertFalse(restore_completed_merge(directory, failed))
        self.assertEqual(self.routes["get_merge"](task_id)["level_progress"][0]["status"], "ready")
        first = Path(self.routes["download_merged_lod"](task_id, 0).path)
        first_modified = first.stat().st_mtime_ns

        await self.routes["start_merge"](task_id, {"levels": [1]})
        await asyncio.wait_for(self.tasks.running[task_id], 5)
        resumed = self.routes["get_merge"](task_id)
        self.assertEqual([item["level"] for item in resumed["merged_lods"]], [0, 1])
        self.assertEqual([item["status"] for item in resumed["level_progress"]], ["ready", "ready"])
        self.assertEqual(Path(self.routes["download_merged_lod"](task_id, 0).path), first)
        self.assertEqual(first.stat().st_mtime_ns, first_modified)

    async def test_rotation_persists_and_preview_matches_export(self):
        status = await self.routes["create_merge"](str(uuid.uuid4()), "[1,1]", [
            gaussian("target.ply", 1000), gaussian("source.ply", 1004, point=(1, 0, 0))])
        task_id = status["task_id"]
        half = math.sqrt(0.5)
        saved = self.routes["save_regions"](task_id, {"axes": [1, 2, 3], "units_confirmed": True,
            "corrections": [[0, 0, 0], [0, 0, 0]], "rotations": [[1, 0, 0, 0], [half, 0, 0, half]],
            "regions": []})
        self.assertEqual(saved["models"][1]["rotation"], [half, 0, 0, half])
        preview = (await self.routes["preview"](task_id))["models"][1][0]
        self.assertAlmostEqual(preview[0], 4)
        self.assertAlmostEqual(preview[1], 1)
        await self.routes["start_merge"](task_id)
        await asyncio.wait_for(self.tasks.running[task_id], 5)
        directory, result = self.tasks.read(task_id)
        layout = read_layout(directory / result["merged_lods"][0]["path"])
        with layout.path.open("rb") as source:
            source.seek(layout.data_start + layout.stride)
            row = struct.unpack("<14f", source.read(layout.stride))
        self.assertAlmostEqual(row[0], preview[0])
        self.assertAlmostEqual(row[1], preview[1])
        self.assertAlmostEqual(row[13], half)

    async def test_editing_target_anchor_preserves_model_alignment_and_boundary(self):
        status = await self.routes["create_merge"](str(uuid.uuid4()), "[1,1]", [
            gaussian("target.ply", 1000), gaussian("source.ply", 1004)])
        task_id = status["task_id"]
        polygon = [[3, -1], [5, -1], [5, 1], [3, 1]]
        self.routes["save_regions"](task_id, {"axes": [1, 2, 3], "units_confirmed": True,
            "corrections": [[0, 0, 0], [0, 0, 0]], "regions": [
                {"kind": "per_model", "actions": ["none", "remove_inside"], "polygon": polygon}]})
        self.routes["save_origin"](task_id, {"epsg": "32650", "mode": "projected", "values": [1001, 2002, 11]})
        self.assertEqual((await self.routes["preview"](task_id))["models"], [[[0, 0, 0]], [[4, 0, 0]]])
        self.assertEqual(self.tasks.read(task_id)[1]["regions"][0]["polygon"], polygon)
        await self.routes["start_merge"](task_id)
        await asyncio.wait_for(self.tasks.running[task_id], 5)
        directory, result = self.tasks.read(task_id)
        self.assertEqual(result["merged_lods"][0]["by_model"], [1, 0])
        self.assertEqual(read_layout(directory / result["merged_lods"][0]["path"]).offset, (1001, 2002, 11))
        wgs84 = self.routes["get_origin"](task_id)["wgs84"]
        self.routes["save_origin"](task_id, {"epsg": "32650", "mode": "wgs84",
            "values": [round(wgs84[0], 10), round(wgs84[1], 10), 11]})
        self.assertEqual(self.tasks.read(task_id)[1]["merge_status"], "ready")
        with self.assertRaises(HTTPException):
            self.routes["save_origin"](task_id, {"epsg": "999999", "mode": "projected",
                "values": [1001, 2002, 11]})

    async def test_reset_target_anchor_restores_uploaded_coordinates(self):
        status = await self.routes["create_merge"](str(uuid.uuid4()), "[1,1]", [
            gaussian("target.ply", 1000), gaussian("source.ply", 1004)])
        task_id = status["task_id"]
        self.routes["save_origin"](task_id, {"epsg": "32650", "mode": "projected",
            "values": [1100, 2100, 20]})
        self.assertEqual(self.routes["save_origin"](task_id, {"mode": "reset"})["projected"],
                         [1000, 2000, 10])
        saved = self.tasks.read(task_id)[1]
        self.assertNotIn("scene_origin", saved)
        self.assertNotIn("scene_epsg", saved)
        self.assertEqual((await self.routes["preview"](task_id))["models"],
                         [[[0, 0, 0]], [[4, 0, 0]]])

    async def test_reset_target_anchor_without_uploaded_geography_restores_unknown(self):
        status = await self.routes["create_merge"](str(uuid.uuid4()), "[1,1]", [
            gaussian("target.ply", 0, geo=False), gaussian("source.ply", 0, geo=False)])
        task_id = status["task_id"]
        self.routes["save_origin"](task_id, {"epsg": "32650", "mode": "projected",
            "values": [1000, 2000, 10]})
        self.assertEqual(self.routes["save_origin"](task_id, {"mode": "reset"}),
                         {"epsg": "", "projected": None, "wgs84": None})
        self.assertIsNone(self.tasks.read(task_id)[1]["models"][0]["offset"])

    async def test_each_model_confirms_units_scale_and_axis_before_merge(self):
        status = await self.routes["create_merge"](str(uuid.uuid4()), "[1,1]", [
            gaussian("target.ply", 1000), gaussian("source.ply", 1004)])
        task_id = status["task_id"]
        settings = [{"axes": [1, -3, 2], "unit": "cm", "scale": 2.0, "confirmed": True},
                    {"axes": [1, 2, 3], "unit": "m", "scale": 1.0, "confirmed": False}]
        payload = {"axes": [1, -3, 2], "units_confirmed": False,
                   "corrections": [[0, 0, 0], [0, 0, 0]], "regions": [], "model_settings": settings}
        self.assertFalse(self.routes["save_regions"](task_id, payload)["units_confirmed"])
        with self.assertRaises(HTTPException):
            await self.routes["start_merge"](task_id)
        settings[1]["confirmed"] = True
        saved = self.routes["save_regions"](task_id, payload)
        self.assertTrue(saved["units_confirmed"])
        self.assertEqual(saved["models"][0]["axes"], [1, -3, 2])
        self.assertEqual(saved["models"][0]["scale"], 2.0)
        self.assertEqual((await self.routes["preview"](task_id))["models"],
                         [[[0, 0, 0]], [[4, 0, 0]]])
        switched = self.routes["save_regions"](task_id, {**payload, "target_model": 1})
        self.assertEqual(switched["axes"], [1, 2, 3])
        self.assertEqual((await self.routes["preview"](task_id))["models"],
                         [[[-4, 0, 0]], [[0, 0, 0]]])
        settings[1]["scale"] = 0
        with self.assertRaises(HTTPException):
            self.routes["save_regions"](task_id, payload)

    async def test_streaming_rejects_noncontiguous_merged_levels(self):
        uploads = [gaussian(f"model-{model}-lod-{level}.ply", 1000 + model * 4)
                   for model in range(2) for level in range(3)]
        status = await self.routes["create_merge"](str(uuid.uuid4()), "[3,3]", uploads)
        task_id = status["task_id"]
        self.routes["save_regions"](task_id, {"axes": [1, 2, 3], "units_confirmed": True,
            "corrections": [[0, 0, 0], [0, 0, 0]], "regions": []})
        await self.routes["start_merge"](task_id, {"levels": [0, 2]})
        await asyncio.wait_for(self.tasks.running[task_id], 5)
        self.assertEqual(self.tasks.read(task_id)[1]["merge_status"], "ready")
        with self.assertRaisesRegex(HTTPException, "连续"):
            await self.routes["generate"](task_id)

    async def test_preview_can_switch_source_lod(self):
        status = await self.routes["create_merge"](str(uuid.uuid4()), "[2,2]", [
            gaussian("a-0.ply", 1000, point=(10, 0, 0)),
            gaussian("a-1.ply", 1000, point=(20, 0, 0)),
            gaussian("b-0.ply", 1000, point=(30, 0, 0)),
            gaussian("b-1.ply", 1000, point=(40, 0, 0))])
        self.assertEqual((await self.routes["preview"](status["task_id"], 0))["models"],
                         [[[10, 0, 0]], [[30, 0, 0]]])
        self.assertEqual((await self.routes["preview"](status["task_id"], 1))["models"],
                         [[[20, 0, 0]], [[40, 0, 0]]])

    async def test_per_model_boundary_is_saved_and_applied_to_all_lods(self):
        status = await self.routes["create_merge"](str(uuid.uuid4()), "[2,2]", [
            gaussian("a-0.ply", 1000), gaussian("a-1.ply", 1000),
            gaussian("b-0.ply", 1000), gaussian("b-1.ply", 1000)])
        boundary = {"kind": "per_model", "actions": ["remove_inside", "none"],
                    "polygon": [[-1, -1], [1, -1], [1, 1], [-1, 1]]}
        saved = self.routes["save_regions"](status["task_id"], {"axes": [1, 2, 3],
            "units_confirmed": True, "corrections": [[0, 0, 0], [0, 0, 0]], "regions": [boundary]})
        self.assertEqual(saved["regions"], [boundary])
        await self.routes["start_merge"](status["task_id"])
        await asyncio.wait_for(self.tasks.running[status["task_id"]], 5)
        self.assertEqual([item["by_model"] for item in self.tasks.read(status["task_id"])[1]["merged_lods"]],
                         [[0, 1], [0, 1]])

    async def test_swap_target_keeps_model_identity_in_rules(self):
        status = await self.routes["create_merge"](str(uuid.uuid4()), "[1,1]", [
            gaussian("a.ply", 1000), gaussian("b.ply", 1004)], 1)
        task_id = status["task_id"]
        self.assertEqual(status["target_model"], 1)
        self.assertEqual((await self.routes["preview"](task_id))["models"],
                         [[[-4, 0, 0]], [[0, 0, 0]]])
        self.routes["save_regions"](task_id, {"axes": [1, 2, 3], "units_confirmed": True,
            "target_model": 1, "corrections": [[0, 0, 0], [0, 0, 0]], "regions": [
                {"kind": "remove", "model": 1,
                 "polygon": [[-1, -1], [1, -1], [1, 1], [-1, 1]]}]})
        await self.routes["start_merge"](task_id)
        await asyncio.wait_for(self.tasks.running[task_id], 5)
        result = self.tasks.read(task_id)[1]
        self.assertEqual(result["merged_lods"][0]["by_model"], [1, 0])
        self.assertEqual(result["merged_lods"][0]["offset"], [1004, 2000, 10])

    async def test_changing_target_translates_existing_regions(self):
        status = await self.routes["create_merge"](str(uuid.uuid4()), "[1,1]", [
            gaussian("a.ply", 1000), gaussian("b.ply", 1004)])
        task_id = status["task_id"]
        region = {"kind": "remove", "model": 1,
                  "polygon": [[3, -1], [5, -1], [5, 1], [3, 1]]}
        payload = {"axes": [1, 2, 3], "units_confirmed": True,
                   "corrections": [[0, 0, 0], [0, 0, 0]], "regions": [region]}
        self.routes["save_regions"](task_id, payload)
        switched = self.routes["save_regions"](task_id, {**payload, "target_model": 1})
        self.assertEqual(switched["regions"][0]["model"], 1)
        self.assertEqual(switched["regions"][0]["polygon"],
                         [[-1, -1], [1, -1], [1, 1], [-1, 1]])

    async def test_missing_geography_uses_target_local_origin_and_saved_correction(self):
        status = await self.routes["create_merge"](str(uuid.uuid4()), "[1,1]", [
            gaussian("target.ply", 0, geo=False), gaussian("source.ply", 0, geo=False)],
            0, '[{"epsg":"","offset":["","",""],"confirmed":false},'
               '{"epsg":"","offset":["","",""],"confirmed":false}]')
        self.assertIsNone(status["models"][0]["offset"])
        task_id = status["task_id"]
        self.routes["save_regions"](task_id, {"axes": [1, 2, 3], "units_confirmed": True,
            "corrections": [[0, 0, 0], [3, 0, 0]], "regions": []})
        self.assertEqual((await self.routes["preview"](task_id))["models"],
                         [[[0, 0, 0]], [[3, 0, 0]]])
        await self.routes["start_merge"](task_id)
        await asyncio.wait_for(self.tasks.running[task_id], 5)
        result = self.tasks.read(task_id)[1]
        self.assertEqual(result["merged_lods"][0]["count"], 2)
        self.assertIsNone(result["merged_lods"][0]["offset"])

    async def test_missing_geography_without_coordinate_form_is_still_accepted(self):
        status = await self.routes["create_merge"](str(uuid.uuid4()), "[1,1]", [
            gaussian("target.ply", 0, geo=False), gaussian("source.ply", 0, geo=False)])
        self.assertEqual([model["offset"] for model in status["models"]], [None, None])

    async def test_manual_confirmed_geography_aligns_preview_before_correction(self):
        status = await self.routes["create_merge"](str(uuid.uuid4()), "[1,1]", [
            gaussian("target.ply", 0, geo=False), gaussian("source.ply", 0, geo=False)], 0,
            '[{"epsg":"32650","offset":["1000","2000","10"],"confirmed":true},'
            '{"epsg":"32650","offset":["1004","2000","10"],"confirmed":true}]')
        self.assertEqual((await self.routes["preview"](status["task_id"]))["models"],
                         [[[0, 0, 0]], [[4, 0, 0]]])
        self.routes["save_regions"](status["task_id"], {"axes": [1, 2, 3], "units_confirmed": True,
            "corrections": [[0, 0, 0], [2, 0, 0]], "regions": []})
        self.assertEqual((await self.routes["preview"](status["task_id"]))["models"],
                         [[[0, 0, 0]], [[6, 0, 0]]])

    async def test_switch_unknown_target_rebases_manual_alignment(self):
        status = await self.routes["create_merge"](str(uuid.uuid4()), "[1,1]", [
            gaussian("target.ply", 0, geo=False), gaussian("source.ply", 0, geo=False)], 0,
            '[{"epsg":"","offset":["","",""],"confirmed":false},'
            '{"epsg":"","offset":["","",""],"confirmed":false}]')
        task_id = status["task_id"]
        payload = {"axes": [1, 2, 3], "units_confirmed": True,
                   "corrections": [[0, 0, 0], [5, 0, 0]], "regions": [
                       {"kind": "remove", "model": 0,
                        "polygon": [[-1, -1], [1, -1], [1, 1], [-1, 1]]}]}
        self.routes["save_regions"](task_id, payload)
        switched = self.routes["save_regions"](task_id, {**payload, "target_model": 1})
        self.assertEqual([model["correction"] for model in switched["models"]],
                         [[-5, 0, 0], [0, 0, 0]])
        self.assertEqual(switched["regions"][0]["polygon"],
                         [[-6, -1], [-4, -1], [-4, 1], [-6, 1]])
        self.assertEqual((await self.routes["preview"](task_id))["models"],
                         [[[-5, 0, 0]], [[0, 0, 0]]])
