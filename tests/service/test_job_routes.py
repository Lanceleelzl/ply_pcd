import io
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi import FastAPI, HTTPException

from service.routes.jobs import create_job_router


class JobRouteTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.status = {"job_id": "job", "status": "running"}
        self.process = Mock(returncode=None)
        self.sync = Mock()
        self.write = Mock(side_effect=lambda _, status: self.status.update(status))
        self.router = create_job_router(
            lambda _: Path("runtime/jobs/job"), lambda _: dict(self.status),
            self.write, self.sync, {"job": self.process},
        )
        self.endpoints = {route.name: route.endpoint for route in self.router.routes}

    async def test_cancel_is_idempotent_and_kills_running_process(self):
        cancel = self.endpoints["cancel_registration"]
        first = await cancel("job")
        second = await cancel("job")
        self.assertEqual(first, second)
        self.assertEqual(first["status"], "cancelled")
        self.process.kill.assert_called_once()
        self.write.assert_called_once()
        self.sync.assert_called_once()

    async def test_completed_job_rejects_cancel(self):
        self.status["status"] = "succeeded"
        with self.assertRaises(HTTPException) as raised:
            await self.endpoints["cancel_registration"]("job")
        self.assertEqual(raised.exception.status_code, 409)
        self.process.kill.assert_not_called()
        self.write.assert_not_called()

    async def test_events_replay_all_or_latest_then_terminal(self):
        self.status["status"] = "succeeded"
        progress = '{"iteration":1}\n{"iteration":2}\n'
        for latest in (False, True):
            with self.subTest(latest=latest), \
                 patch.object(Path, "is_file", return_value=True), \
                 patch.object(Path, "open", side_effect=lambda *a, **kw: io.StringIO(progress)):
                response = await self.endpoints["stream_registration_events"]("job", latest)
                events = [event async for event in response.body_iterator]
            iterations = events[:-1]
            self.assertEqual(len(iterations), 1 if latest else 2)
            self.assertIn('data: {"iteration":2}', iterations[-1])
            self.assertEqual(events[-1], 'event: terminal\ndata: {"status":"succeeded"}\n\n')
            self.assertEqual(response.headers["cache-control"], "no-cache")

    async def test_unlisted_download_is_rejected(self):
        with self.assertRaises(HTTPException) as raised:
            await self.endpoints["download_result_file"]("job", "status.json")
        self.assertEqual(raised.exception.status_code, 404)

    async def test_cancel_http_route_returns_conflict_for_completed_job(self):
        self.status["status"] = "succeeded"
        app = FastAPI()
        app.include_router(self.router)
        messages = []

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message):
            messages.append(message)

        await app({
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
            "method": "POST", "scheme": "http", "path": "/api/v1/registrations/job/cancel",
            "query_string": b"", "root_path": "", "headers": [],
            "client": ("127.0.0.1", 1234), "server": ("127.0.0.1", 8865),
        }, receive, send)
        self.assertEqual(messages[0]["status"], 409)
        self.process.kill.assert_not_called()
