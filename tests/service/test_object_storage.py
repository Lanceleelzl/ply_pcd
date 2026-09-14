import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from botocore.exceptions import ClientError

from service.object_storage import ObjectStorageSettings, S3ObjectStorage, create_object_storage


class ObjectStorageTest(unittest.TestCase):
    def test_local_is_default_and_s3_requires_bucket(self):
        self.assertFalse(create_object_storage(ObjectStorageSettings()).enabled)
        with self.assertRaisesRegex(ValueError, "S3_BUCKET"):
            create_object_storage(ObjectStorageSettings(backend="s3"))

    def test_minio_client_uses_endpoint_and_path_style(self):
        client = Mock()
        with patch("service.object_storage.boto3.client", return_value=client) as factory:
            store = create_object_storage(ObjectStorageSettings(
                backend="s3", bucket="models", prefix="tenant/", endpoint_url="http://minio:9000",
                region="us-east-1", addressing_style="path",
            ))
        self.assertEqual(store.key("sessions", "abc", "model-a.ply"), "tenant/sessions/abc/model-a.ply")
        arguments = factory.call_args
        self.assertEqual(arguments.kwargs["endpoint_url"], "http://minio:9000")
        self.assertEqual(arguments.kwargs["config"].s3["addressing_style"], "path")

    def test_upload_download_exists_and_atomic_destination(self):
        client = Mock()
        store = S3ObjectStorage(ObjectStorageSettings(backend="s3", bucket="models"), client=client)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.ply"
            source.write_bytes(b"ply")
            destination = root / "nested" / "target.ply"
            store.upload_file(source, "registration/source.ply")

            def download(_bucket, _key, filename):
                Path(filename).write_bytes(b"restored")

            client.download_file.side_effect = download
            store.download_file("registration/source.ply", destination)
            self.assertEqual(destination.read_bytes(), b"restored")
            client.upload_file.assert_called_once_with(str(source), "models", "registration/source.ply")
        client.head_object.return_value = {}
        self.assertTrue(store.exists("registration/source.ply"))

    def test_not_found_and_paginated_prefix_delete(self):
        client = Mock()
        client.head_object.side_effect = ClientError({"Error": {"Code": "404"}}, "HeadObject")
        paginator = client.get_paginator.return_value
        paginator.paginate.return_value = [
            {"Contents": [{"Key": "root/a"}, {"Key": "root/b"}]}, {"Contents": []},
        ]
        store = S3ObjectStorage(ObjectStorageSettings(backend="s3", bucket="models"), client=client)
        self.assertFalse(store.exists("root/missing"))
        store.delete_prefix("root/")
        client.delete_objects.assert_called_once_with(
            Bucket="models", Delete={"Objects": [{"Key": "root/a"}, {"Key": "root/b"}], "Quiet": True}
        )

    def test_key_rejects_parent_traversal(self):
        store = S3ObjectStorage(ObjectStorageSettings(backend="s3", bucket="models"), client=Mock())
        with self.assertRaises(ValueError):
            store.key("sessions", "../other")
