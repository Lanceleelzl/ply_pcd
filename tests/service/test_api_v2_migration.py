import unittest
from pathlib import Path
from unittest.mock import patch

from service import app as service


class ApiV2MigrationTest(unittest.IsolatedAsyncioTestCase):
    async def test_v1_endpoints_are_not_served(self):
        for path, method in (
            ("/api/v1/registrations", "POST"),
            ("/api/v1/registrations/job/cancel", "POST"),
            ("/api/v1/manual-registration-sessions", "POST"),
            ("/manual-registration/session", "GET"),
        ):
            messages = []

            async def receive():
                return {"type": "http.request", "body": b"", "more_body": False}

            async def send(message):
                messages.append(message)

            await service.app({
                "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
                "method": method, "scheme": "http", "path": path,
                "query_string": b"", "root_path": "", "headers": [],
                "client": ("127.0.0.1", 1234), "server": ("127.0.0.1", 8865),
            }, receive, send)
            self.assertEqual(messages[0]["status"], 404, path)

    def test_task_contracts_are_all_registered_under_v2(self):
        paths = service.app.openapi()["paths"]
        self.assertFalse(any(path.startswith("/api/v1/") for path in paths))
        for suffix in ("", "/events", "/cancel", "/result", "/files/{filename}"):
            self.assertIn("/api/v2/registrations/{job_id}" + suffix, paths)

    def test_persisted_task_links_are_normalized_without_writing(self):
        status = {"result_url": "/api/v1/registrations/job/result", "registrations": [
            {"status_url": "/api/v1/registrations/job", "progress_url": "/api/v1/registrations/job/events"},
        ]}
        with patch.object(service, "_storage_read_status", return_value=status), \
             patch.object(service, "_storage_write_status") as write:
            result = service._read_status(Path("runtime/jobs/job"))
        self.assertEqual(result["result_url"], "/api/v2/registrations/job/result")
        self.assertEqual(result["registrations"][0]["progress_url"], "/api/v2/registrations/job/events")
        write.assert_not_called()
