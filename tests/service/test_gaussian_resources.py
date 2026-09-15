import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException

from service.routes.gaussian_resources import create_gaussian_resource_router


class GaussianResourcesTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        resource = self.directory / "datasets" / "model-a" / "scene" / "0_0" / "meta.json"
        resource.parent.mkdir(parents=True)
        resource.write_text("{}", encoding="utf-8")
        self.status = {
            "preview_access_token": "secret",
            "inputs": {"model_a_dataset": {
                "container": "zip", "format": "streamed_sog",
                "gaussian_path": "datasets/model-a/scene/lod-meta.json",
            }},
        }
        router = create_gaussian_resource_router(lambda _: self.directory, lambda _: self.status)
        self.get = router.routes[0].endpoint

    async def asyncTearDown(self):
        self.temporary.cleanup()

    async def test_serves_relative_streaming_resource_with_valid_token(self):
        response = await self.get("session", "secret", "a", "datasets/model-a/scene/0_0/meta.json")
        self.assertEqual(Path(response.path), self.directory / "datasets" / "model-a" / "scene" / "0_0" / "meta.json")
        self.assertEqual(response.media_type, "application/json")

    async def test_rejects_wrong_token_other_model_and_outside_dataset(self):
        for token, model, path in (
            ("wrong", "a", "datasets/model-a/scene/0_0/meta.json"),
            ("secret", "b", "datasets/model-a/scene/0_0/meta.json"),
            ("secret", "a", "input/model-b.ply"),
            ("secret", "a", "../status.json"),
        ):
            with self.subTest(token=token, model=model, path=path), self.assertRaises(HTTPException) as error:
                await self.get("session", token, model, path)
            self.assertEqual(error.exception.status_code, 404)
