# Skymail Mail Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `skymail` registration mail provider that can create mailbox users and read verification emails through the Skymail public API.

**Architecture:** The existing registration flow already depends on `services/register/mail_provider.py` for provider-specific mailbox creation and message polling. Add a `SkymailProvider` class that follows the existing `BaseMailProvider` interface, then expose it in the provider factory and the registration UI.

**Tech Stack:** Python 3.13, `requests`, FastAPI config persistence through `data/register.json`, Next.js/React TypeScript frontend, `unittest` with `unittest.mock` for provider tests.

---

## File Structure

- Modify `services/register/mail_provider.py`
  - Add `SkymailProvider` beside the existing provider classes.
  - Add `skymail` to `_create_provider()`.
  - Keep all Skymail-specific request/response parsing inside this class.
- Modify `web/src/app/register/components/register-card.tsx`
  - Add `skymail` to the provider type selector.
  - Add fields for API Base, Admin Email, Admin Password, and Domain.
  - Initialize new `skymail` providers with safe default field values.
- Create `test/test_skymail_mail_provider.py`
  - Unit-test mailbox creation and message fetching without real network calls.
  - Assert request paths, payloads, headers, and normalized message output.
- Do not commit credentials.
  - Runtime configuration belongs in `data/register.json` or the admin UI.
  - Use placeholder values in tests and examples.

---

### Task 1: Backend Skymail Provider Tests

**Files:**
- Create: `test/test_skymail_mail_provider.py`
- Read-only reference: `services/register/mail_provider.py`

- [ ] **Step 1: Write failing tests for mailbox creation and message fetch**

Create `test/test_skymail_mail_provider.py` with this content:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
uv run python -m unittest test.test_skymail_mail_provider -v
```

Expected: FAIL with `RuntimeError: 不支持的 mail.provider: skymail` or equivalent because the provider is not implemented yet.

- [ ] **Step 3: Commit the failing tests**

```bash
git add test/test_skymail_mail_provider.py
git commit -m "test: cover skymail registration mail provider"
```

---

### Task 2: Backend Skymail Provider Implementation

**Files:**
- Modify: `services/register/mail_provider.py`
- Test: `test/test_skymail_mail_provider.py`

- [ ] **Step 1: Add the provider class**

In `services/register/mail_provider.py`, insert this class after `GptMailProvider` and before `_entries()`:

```python
class SkymailProvider(BaseMailProvider):
    name = "skymail"

    def __init__(self, entry: dict, conf: dict):
        super().__init__(conf, str(entry.get("provider_ref") or ""))
        self.api_base = str(entry["api_base"]).rstrip("/")
        self.admin_email = str(entry["admin_email"]).strip()
        self.admin_password = str(entry["admin_password"]).strip()
        self.domain = entry.get("domain") or []
        self.session = requests.Session()
        self.session.trust_env = False
        self.session.headers.update({"User-Agent": conf["user_agent"], "Accept": "application/json", "Content-Type": "application/json"})

    def _request(self, method: str, path: str, token: str = "", payload: dict | None = None):
        headers = {"Authorization": token} if token else {}
        resp = self.session.request(method.upper(), f"{self.api_base}{path}", headers=headers, json=payload, timeout=self.conf["request_timeout"], verify=False)
        if resp.status_code != 200:
            raise RuntimeError(f"Skymail 请求失败: {method} {path}, HTTP {resp.status_code}, body={resp.text[:300]}")
        data = resp.json()
        if not isinstance(data, dict):
            raise RuntimeError(f"Skymail {method} {path} 返回结构不是对象")
        if data.get("code") != 200:
            raise RuntimeError(f"Skymail 请求失败: {method} {path}, code={data.get('code')}, message={data.get('message')}")
        return data.get("data")

    def _token(self) -> str:
        data = self._request("POST", "/api/public/genToken", payload={"email": self.admin_email, "password": self.admin_password})
        token = str((data or {}).get("token") or "").strip() if isinstance(data, dict) else ""
        if not token:
            raise RuntimeError("Skymail 缺少 token")
        return token

    def create_mailbox(self, username: str | None = None) -> dict[str, Any]:
        token = self._token()
        address = f"{username or _random_mailbox_name()}@{_next_domain(self.domain)}"
        password = "".join(random.choices(string.ascii_letters + string.digits, k=12))
        self._request("POST", "/api/public/addUser", token=token, payload={"list": [{"email": address, "password": password}]})
        return {"provider": self.name, "provider_ref": self.provider_ref, "address": address, "token": token, "password": password}

    def fetch_latest_message(self, mailbox: dict[str, Any]) -> dict[str, Any] | None:
        data = self._request(
            "POST",
            "/api/public/emailList",
            token=str(mailbox.get("token") or ""),
            payload={"toEmail": mailbox["address"], "timeSort": "desc", "type": 0, "isDel": 0, "num": 1, "size": 10},
        )
        items = data if isinstance(data, list) else []
        messages = [item for item in items if isinstance(item, dict) and _message_matches_email(item, str(mailbox.get("address") or ""))]
        if not messages:
            return None
        item = messages[0]
        return {
            "provider": self.name,
            "mailbox": mailbox["address"],
            "message_id": str(item.get("emailId") or ""),
            "subject": str(item.get("subject") or ""),
            "sender": str(item.get("sendEmail") or item.get("sendName") or ""),
            "text_content": str(item.get("text") or ""),
            "html_content": str(item.get("content") or ""),
            "received_at": _parse_received_at(item.get("createTime")),
            "raw": item,
        }

    def close(self) -> None:
        self.session.close()
```

- [ ] **Step 2: Register the provider in the factory**

In `_create_provider()` in `services/register/mail_provider.py`, add this branch after the `gptmail` branch:

```python
    if entry["type"] == "skymail":
        return SkymailProvider(entry, conf)
```

The final branch area should be:

```python
    if entry["type"] == "duckmail":
        return DuckMailProvider(entry, conf)
    if entry["type"] == "gptmail":
        return GptMailProvider(entry, conf)
    if entry["type"] == "skymail":
        return SkymailProvider(entry, conf)
    raise RuntimeError(f"不支持的 mail.provider: {entry['type']}")
```

- [ ] **Step 3: Run backend provider tests**

Run:

```bash
uv run python -m unittest test.test_skymail_mail_provider -v
```

Expected: PASS all 4 tests.

- [ ] **Step 4: Run all Python tests**

Run:

```bash
uv run python -m unittest discover -s test -v
```

Expected: PASS existing tests and the new Skymail tests.

- [ ] **Step 5: Commit backend implementation**

```bash
git add services/register/mail_provider.py
git commit -m "feat: add skymail registration mail provider"
```

---

### Task 3: Frontend Registration Config Support

**Files:**
- Modify: `web/src/app/register/components/register-card.tsx`
- Test: manual UI check plus TypeScript/lint command available in the repo

- [ ] **Step 1: Add Skymail defaults to provider type switching**

In `web/src/app/register/components/register-card.tsx`, update `updateProviderType()` to include `skymail`:

```tsx
  const updateProviderType = (index: number, type: string) => {
    updateProvider(index, {
      type,
      enable: true,
      ...(type === "cloudflare_temp_email" ? { api_base: "", admin_password: "", domain: [] } : {}),
      ...(type === "tempmail_lol" ? { api_key: "", domain: [] } : {}),
      ...(type === "duckmail" ? { api_key: "", default_domain: "duckmail.sbs" } : {}),
      ...(type === "gptmail" ? { api_key: "", default_domain: "" } : {}),
      ...(type === "skymail" ? { api_base: "https://qlcc.online", admin_email: "", admin_password: "", domain: ["qlcc.online"] } : {}),
    });
  };
```

- [ ] **Step 2: Add Skymail to the provider selector**

In the `<SelectContent>` for provider types, add:

```tsx
                            <SelectItem value="skymail">skymail</SelectItem>
```

The list should become:

```tsx
                          <SelectContent>
                            <SelectItem value="cloudflare_temp_email">cloudflare_temp_email</SelectItem>
                            <SelectItem value="tempmail_lol">tempmail_lol</SelectItem>
                            <SelectItem value="duckmail">duckmail</SelectItem>
                            <SelectItem value="gptmail">gptmail(未测试)</SelectItem>
                            <SelectItem value="skymail">skymail</SelectItem>
                          </SelectContent>
```

- [ ] **Step 3: Render Skymail fields**

Replace the Cloudflare-only API Base/Admin Password block:

```tsx
                      {type === "cloudflare_temp_email" ? (
                        <>
                          <div className="space-y-2">
                            <label className="text-sm text-stone-700">API Base</label>
                            <Input value={String(provider.api_base || "")} onChange={(event) => updateProvider(index, { api_base: event.target.value })} className="h-10 rounded-xl border-stone-200 bg-white" disabled={config.enabled} />
                          </div>
                          <div className="space-y-2">
                            <label className="text-sm text-stone-700">Admin Password</label>
                            <Input value={String(provider.admin_password || "")} onChange={(event) => updateProvider(index, { admin_password: event.target.value })} className="h-10 rounded-xl border-stone-200 bg-white" disabled={config.enabled} />
                          </div>
                        </>
                      ) : null}
```

With this combined Cloudflare/Skymail block:

```tsx
                      {type === "cloudflare_temp_email" || type === "skymail" ? (
                        <>
                          <div className="space-y-2">
                            <label className="text-sm text-stone-700">API Base</label>
                            <Input value={String(provider.api_base || "")} onChange={(event) => updateProvider(index, { api_base: event.target.value })} className="h-10 rounded-xl border-stone-200 bg-white" disabled={config.enabled} />
                          </div>
                          {type === "skymail" ? (
                            <div className="space-y-2">
                              <label className="text-sm text-stone-700">Admin Email</label>
                              <Input value={String(provider.admin_email || "")} onChange={(event) => updateProvider(index, { admin_email: event.target.value })} className="h-10 rounded-xl border-stone-200 bg-white" disabled={config.enabled} />
                            </div>
                          ) : null}
                          <div className="space-y-2">
                            <label className="text-sm text-stone-700">Admin Password</label>
                            <Input value={String(provider.admin_password || "")} onChange={(event) => updateProvider(index, { admin_password: event.target.value })} className="h-10 rounded-xl border-stone-200 bg-white" disabled={config.enabled} />
                          </div>
                        </>
                      ) : null}
```

- [ ] **Step 4: Show Domain textarea for Skymail**

Change this condition:

```tsx
                    {type === "tempmail_lol" || type === "cloudflare_temp_email" ? (
```

To:

```tsx
                    {type === "tempmail_lol" || type === "cloudflare_temp_email" || type === "skymail" ? (
```

- [ ] **Step 5: Run frontend checks**

First inspect available scripts:

```bash
cd web && npm run
```

Then run the available check command. If `typecheck` exists, run:

```bash
cd web && npm run typecheck
```

If there is no `typecheck` but `lint` exists, run:

```bash
cd web && npm run lint
```

Expected: command exits with code 0. If no check script exists, record that explicitly in the completion summary.

- [ ] **Step 6: Manually verify UI in browser**

Run the dev server:

```bash
cd web && npm run dev
```

Open the registration config page, select provider type `skymail`, and verify these fields appear and are editable while the register task is stopped:

- API Base
- Admin Email
- Admin Password
- Domain

Save a config with placeholder-safe values except real credentials entered manually by the operator. Confirm the page shows `注册配置已保存` and does not crash.

- [ ] **Step 7: Commit frontend implementation**

```bash
git add web/src/app/register/components/register-card.tsx
git commit -m "feat: expose skymail registration provider settings"
```

---

### Task 4: Optional Local Configuration and Final Verification

**Files:**
- Optional modify: `data/register.json`
- Do not commit: `data/register.json` if it contains real credentials.

- [ ] **Step 1: Configure Skymail locally through the UI or `data/register.json`**

Use this shape, replacing sensitive values locally only:

```json
{
  "enable": true,
  "type": "skymail",
  "api_base": "https://qlcc.online",
  "admin_email": "<admin email>",
  "admin_password": "<admin password>",
  "domain": ["qlcc.online"]
}
```

Do not include real passwords in commits, tests, docs, or command output.

- [ ] **Step 2: Run the Python test suite again**

Run:

```bash
uv run python -m unittest discover -s test -v
```

Expected: PASS.

- [ ] **Step 3: Run frontend verification again**

Run the same frontend check command identified in Task 3 Step 5.

Expected: PASS, or explicitly note that the repo has no frontend check script.

- [ ] **Step 4: Check git status for accidental secrets**

Run:

```bash
git status --short
git diff -- data/register.json
```

Expected: `data/register.json` is either unchanged, untracked local-only, or contains no committed real credentials. If it contains real credentials, do not stage it.

- [ ] **Step 5: Commit any remaining non-secret verification fixes**

Only if Task 4 produced code fixes, run:

```bash
git add services/register/mail_provider.py web/src/app/register/components/register-card.tsx test/test_skymail_mail_provider.py
git commit -m "fix: finalize skymail registration provider"
```

Skip this step if there are no remaining code changes.

---

## Self-Review

- Spec coverage: Backend provider, Skymail token generation, user creation, email polling, frontend configuration fields, testing, and secret-handling are all covered by Tasks 1-4.
- Placeholder scan: The only angle-bracket placeholders are in the local-only configuration example and are explicitly marked as values not to commit. There are no implementation placeholders.
- Type consistency: Provider type is consistently `skymail`; config keys are consistently `api_base`, `admin_email`, `admin_password`, and `domain`; mailbox keys are consistently `provider`, `provider_ref`, `address`, `token`, and `password`.
