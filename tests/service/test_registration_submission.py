import asyncio
import copy
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi import HTTPException

from service.routes.registrations import create_registration_router
from service.schemas import ModelRegistrationRequest


class RegistrationSubmissionTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.session = Path("runtime/manual-sessions/session")
        self.states = {self.session: {
            "api_version": "v2", "status": "ready", "inputs": {},
            "model_a_filename": "a.ply", "model_b_filename": "b.pcd",
        }}
        self.start = Mock()
        self.persist = Mock()
        self.restore = Mock(return_value=True)
        self.available = Mock(return_value=True)
        self.router = create_registration_router(
            lambda _: self.session, lambda job: Path("runtime/jobs") / job,
            lambda path: copy.deepcopy(self.states[path]),
            lambda path, status: self.states.__setitem__(path, copy.deepcopy(status)),
            self.available, asyncio.Lock(), "worker", self.restore, self.persist, self.start,
        )
        self.submit = self.router.routes[0].endpoint

    def request(self, **values):
        return ModelRegistrationRequest(
            initial_moving_local_to_fixed_local=[
                [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1],
            ], **values,
        )

    async def test_duplicate_submission_starts_one_worker(self):
        with patch.object(Path, "mkdir"), patch.object(Path, "write_text"):
            outcomes = await asyncio.gather(
                self.submit("session", self.request()),
                self.submit("session", self.request()), return_exceptions=True,
            )
        self.start.assert_called_once()
        self.assertNotIn("--adjust-scale", self.start.call_args.args[1])
        self.persist.assert_called_once()
        self.assertEqual(outcomes[0]["status"], "queued")
        self.assertIsInstance(outcomes[1], HTTPException)
        self.assertEqual(outcomes[1].status_code, 409)
        self.assertEqual(len(self.states[self.session]["registrations"]), 1)

    async def test_uniform_initial_scale_is_accepted_and_nonuniform_is_rejected(self):
        uniform = self.request()
        for axis in range(3):
            uniform.initial_moving_local_to_fixed_local[axis][axis] = 2
        with patch.object(Path, "mkdir"), patch.object(Path, "write_text"):
            await self.submit("session", uniform)
        self.start.assert_called_once()

        nonuniform = self.request()
        nonuniform.initial_moving_local_to_fixed_local[0][0] = 2
        with self.assertRaises(HTTPException) as raised:
            await self.submit("session", nonuniform)
        self.assertEqual(raised.exception.status_code, 400)

    async def test_business_submission_writes_both_transforms_and_progress_flag(self):
        with patch.object(Path, "mkdir"), patch.object(Path, "write_text") as write:
            response = await self.submit("session", self.request(
                coordinate_space="business", output_direction="b_to_a", moving_model="a", adjust_scale=True,
            ))
        command = self.start.call_args.args[1]
        self.persist.assert_called_once_with(Path("runtime/jobs") / response["job_id"], command)
        self.assertEqual(command[:2], ["worker", "register-models"])
        for flag in ("--model-a-to-business", "--model-b-to-business", "--progress-jsonl"):
            self.assertIn(flag, command)
        self.assertEqual(command[command.index("--output-direction") + 1], "b_to_a")
        self.assertEqual(command[command.index("--moving-model") + 1], "a")
        self.assertIn("--adjust-scale", command)
        self.assertTrue(self.states[self.session]["registrations"][0]["parameters"]["adjust_scale"])
        self.assertEqual(write.call_count, 3)
        self.assertEqual(self.states[Path("runtime/jobs") / response["job_id"]]["coordinate_space"], "business")

    async def test_missing_sources_reject_before_writes(self):
        self.available.return_value = False
        with self.assertRaises(HTTPException) as raised, patch.object(Path, "mkdir") as mkdir:
            await self.submit("session", self.request())
        self.assertEqual(raised.exception.status_code, 409)
        mkdir.assert_not_called()
        self.start.assert_not_called()
        self.persist.assert_not_called()

    async def test_region_polygon_is_written_for_explicit_business_role(self):
        polygon = [[0, 0], [10, 0], [10, 10], [0, 10]]
        with patch.object(Path, "mkdir"), patch.object(Path, "write_text") as write:
            await self.submit("session", self.request(
                coordinate_space="business", moving_model="a", region_polygon=polygon,
            ))
        command = self.start.call_args.args[1]
        self.assertIn("--region-polygon", command)
        self.assertTrue(any("0 0\n10 0\n10 10\n0 10\n" == call.args[0] for call in write.call_args_list))
        self.assertEqual(self.states[self.session]["registrations"][0]["region_polygon"], polygon)

    async def test_invalid_region_is_rejected_before_job_creation(self):
        for polygon in ([[0, 0], [1, 1], [2, 2]], [[0, 0], [1, 0]]):
            with self.assertRaises(HTTPException) as raised:
                await self.submit("session", self.request(
                    coordinate_space="business", moving_model="a", region_polygon=polygon,
                ))
            self.assertEqual(raised.exception.status_code, 400)
        with self.assertRaises(HTTPException):
            await self.submit("session", self.request(
                coordinate_space="business", moving_model="auto",
                region_polygon=[[0, 0], [1, 0], [0, 1]],
            ))
        self.start.assert_not_called()

    async def test_invalid_direction_rejects_before_submission(self):
        with self.assertRaises(HTTPException) as raised:
            await self.submit("session", self.request(output_direction="invalid"))
        self.assertEqual(raised.exception.status_code, 400)
        self.start.assert_not_called()
        self.persist.assert_not_called()
        self.assertNotIn("active_job_id", self.states[self.session])

    async def test_overlap_lower_bound_is_accepted_and_smaller_value_rejected(self):
        with patch.object(Path, "mkdir"), patch.object(Path, "write_text"):
            await self.submit("session", self.request(overlap=0.2))
        command = self.start.call_args.args[1]
        self.assertEqual(command[command.index("--overlap") + 1], "0.2")

        with self.assertRaises(HTTPException) as raised:
            await self.submit("session", self.request(overlap=0.19))
        self.assertEqual(raised.exception.status_code, 400)
