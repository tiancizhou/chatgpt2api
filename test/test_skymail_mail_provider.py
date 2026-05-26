import unittest
from unittest import mock

from services.register import mail_provider


class FakeResponse:
    def __init__(self, status_code=200, data=None, text=""):
        self.status_code = status_code
        self._data = data if data is not None else {}
        self.text = text

    def json(self):
        return self._data


class FakeSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
        self.headers = {}
        self.trust_env = True
        self.closed = False

    def request(self, method, url, headers=None, params=None, json=None, timeout=None, verify=None):
        self.calls.append(
            {
                "method": method,
                "url": url,
                "headers": headers or {},
                "params": params,
                "json": json,
                "timeout": timeout,
                "verify": verify,
            }
        )
        if not self.responses:
            raise AssertionError("Unexpected HTTP request")
        return self.responses.pop(0)

    def close(self):
        self.closed = True


class SkymailProviderTests(unittest.TestCase):
    def _mail_config(self):
        return {
            "request_timeout": 15,
            "wait_timeout": 1,
            "wait_interval": 1,
            "providers": [
                {
                    "enable": True,
                    "type": "skymail",
                    "api_base": "https://mail.example.test/",
                    "admin_email": "admin@example.test",
                    "admin_password": "secret-password",
                    "domain": ["example.test"],
                }
            ],
        }

    def test_create_mailbox_adds_skymail_user(self):
        session = FakeSession(
            [
                FakeResponse(data={"code": 200, "message": "success", "data": {"token": "token-123"}}),
                FakeResponse(data={"code": 200, "message": "success", "data": None}),
            ]
        )
        with mock.patch.object(mail_provider.requests, "Session", return_value=session):
            mailbox = mail_provider.create_mailbox(self._mail_config(), "alice")

        self.assertEqual(mailbox["provider"], "skymail")
        self.assertEqual(mailbox["address"], "alice@example.test")
        self.assertEqual(mailbox["token"], "token-123")
        self.assertTrue(session.closed)
        self.assertEqual(session.calls[0]["method"], "POST")
        self.assertEqual(session.calls[0]["url"], "https://mail.example.test/api/public/genToken")
        self.assertEqual(session.calls[0]["json"], {"email": "admin@example.test", "password": "secret-password"})
        self.assertEqual(session.calls[1]["method"], "POST")
        self.assertEqual(session.calls[1]["url"], "https://mail.example.test/api/public/addUser")
        self.assertEqual(session.calls[1]["headers"], {"Authorization": "token-123"})
        self.assertEqual(
            session.calls[1]["json"],
            {"list": [{"email": "alice@example.test", "password": mailbox["password"]}]},
        )
        self.assertTrue(mailbox["password"])

    def test_fetch_latest_message_reads_skymail_email_list(self):
        session = FakeSession(
            [
                FakeResponse(
                    data={
                        "code": 200,
                        "message": "success",
                        "data": [
                            {
                                "emailId": 999,
                                "sendEmail": "noreply@example.test",
                                "sendName": "OpenAI",
                                "subject": "Verification code",
                                "toEmail": "alice@example.test",
                                "createTime": "2026-04-29 04:35:05",
                                "type": 0,
                                "content": "<p>Your code is 123456</p>",
                                "text": "Your code is 123456",
                                "isDel": 0,
                            }
                        ],
                    }
                )
            ]
        )
        with mock.patch.object(mail_provider.requests, "Session", return_value=session):
            code = mail_provider.wait_for_code(
                self._mail_config(),
                {
                    "provider": "skymail",
                    "provider_ref": "skymail#1",
                    "address": "alice@example.test",
                    "token": "token-123",
                },
            )

        self.assertEqual(code, "123456")
        self.assertTrue(session.closed)
        self.assertEqual(session.calls[0]["method"], "POST")
        self.assertEqual(session.calls[0]["url"], "https://mail.example.test/api/public/emailList")
        self.assertEqual(session.calls[0]["headers"], {"Authorization": "token-123"})
        self.assertEqual(
            session.calls[0]["json"],
            {
                "toEmail": "alice@example.test",
                "timeSort": "desc",
                "type": 0,
                "isDel": 0,
                "num": 1,
                "size": 10,
            },
        )

    def test_create_mailbox_requires_domain(self):
        config = self._mail_config()
        config["providers"][0]["domain"] = []
        with self.assertRaisesRegex(RuntimeError, "mail.domain 不能为空"):
            mail_provider.create_mailbox(config, "alice")

    def test_token_response_must_include_token(self):
        session = FakeSession([FakeResponse(data={"code": 200, "message": "success", "data": {}})])
        with mock.patch.object(mail_provider.requests, "Session", return_value=session):
            with self.assertRaisesRegex(RuntimeError, "Skymail 缺少 token"):
                mail_provider.create_mailbox(self._mail_config(), "alice")


if __name__ == "__main__":
    unittest.main()
