import hashlib
import json
import unittest

from fastapi import HTTPException

from service.auth import (
    ApiKeyAuthMiddleware, ApiKeyAuthenticator, Principal, authorize_resource,
    current_principal, resource_owned_by,
)


class AuthTest(unittest.TestCase):
    def test_disabled_auth_uses_compatible_anonymous_admin(self):
        principal = ApiKeyAuthenticator(False, "").authenticate(None)
        self.assertEqual(principal, Principal("anonymous", "admin"))

    def test_valid_key_returns_configured_identity_without_exposing_key(self):
        secret = "example-secret"
        digest = hashlib.sha256(secret.encode()).hexdigest()
        authenticator = ApiKeyAuthenticator(True, f"lee:user:{digest}")
        self.assertEqual(authenticator.authenticate(secret), Principal("lee", "user"))
        self.assertIsNone(authenticator.authenticate("wrong"))
        self.assertNotIn(secret, repr(authenticator.records))

    def test_enabled_auth_requires_valid_unique_records(self):
        invalid = ("", "lee:user:nope", "lee:user:" + "a" * 64 + ",lee:admin:" + "b" * 64)
        for specification in invalid:
            with self.subTest(specification=specification), self.assertRaises(ValueError):
                ApiKeyAuthenticator(True, specification)

    def test_owner_and_admin_access(self):
        self.assertTrue(resource_owned_by(Principal("lee", "user"), "lee"))
        self.assertFalse(resource_owned_by(Principal("other", "user"), "lee"))
        self.assertTrue(resource_owned_by(Principal("ops", "admin"), "lee"))


class AuthMiddlewareTest(unittest.IsolatedAsyncioTestCase):
    async def request(self, authenticator, api_key=None, owner_id=None):
        async def endpoint(scope, receive, send):
            try:
                if owner_id is not None:
                    authorize_resource({"owner_id": owner_id})
                payload = json.dumps({"key_id": current_principal().key_id}).encode()
                await send({"type": "http.response.start", "status": 200, "headers": []})
                await send({"type": "http.response.body", "body": payload})
            except HTTPException as error:
                await send({"type": "http.response.start", "status": error.status_code, "headers": []})
                await send({"type": "http.response.body", "body": b""})

        messages = []
        async def send(message):
            messages.append(message)
        headers = [] if api_key is None else [(b"x-api-key", api_key.encode())]
        scope = {"type": "http", "path": "/api/v2/resource", "headers": headers}
        await ApiKeyAuthMiddleware(endpoint, authenticator)(
            scope, lambda: None, send,
        )
        return messages

    async def test_missing_and_wrong_key_return_api_key_challenge(self):
        digest = hashlib.sha256(b"secret").hexdigest()
        authenticator = ApiKeyAuthenticator(True, f"lee:user:{digest}")
        for key in (None, "wrong"):
            messages = await self.request(authenticator, key)
            self.assertEqual(messages[0]["status"], 401)
            self.assertIn((b"www-authenticate", b"APIKey"), messages[0]["headers"])

    async def test_user_is_isolated_and_admin_can_read(self):
        user_digest = hashlib.sha256(b"user-secret").hexdigest()
        admin_digest = hashlib.sha256(b"admin-secret").hexdigest()
        authenticator = ApiKeyAuthenticator(
            True, f"lee:user:{user_digest},ops:admin:{admin_digest}"
        )
        own = await self.request(authenticator, "user-secret", "lee")
        other = await self.request(authenticator, "user-secret", "other")
        admin = await self.request(authenticator, "admin-secret", "other")
        self.assertEqual([own[0]["status"], other[0]["status"], admin[0]["status"]], [200, 404, 200])
