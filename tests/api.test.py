"""Temporary end-to-end API check against the local Pages dev server."""
import json
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8788"
results = []


def call(method, path, body=None, token=None):
    url = BASE + path
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            raw = resp.read().decode("utf-8")
            status = resp.status
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8")
        status = err.code
    try:
        return status, json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return status, {"raw": raw}


def check(label, condition, detail=""):
    results.append((label, bool(condition), detail))
    print(("PASS " if condition else "FAIL ") + label + (("  " + str(detail)) if not condition else ""))


# --- setup / auth ---
st, js = call("GET", "/api/v1/auth/setup")
check("setup probe reports uninitialized", js.get("data", {}).get("initialized") is False, js)

st, js = call("POST", "/api/v1/auth/setup", {"username": "admin", "password": "StrongPass123"})
check("create admin", st == 200 and js.get("success"), (st, js))

st, js = call("GET", "/api/v1/auth/setup")
check("setup closes after init", js.get("data", {}).get("setup_available") is False, js)

st, js = call("POST", "/api/v1/auth/login", {"username": "admin", "password": "wrong"})
check("bad password rejected", st == 401, (st, js))

st, js = call("POST", "/api/v1/auth/login", {"username": "admin", "password": "StrongPass123"})
token = js.get("token", "")
check("login returns token", st == 200 and len(token) > 20, (st, js))

st, js = call("GET", "/api/v1/groups")
check("unauthenticated blocked (401)", st == 401, (st, js))

# --- groups ---
st, js = call("POST", "/api/v1/groups",
              {"name": "default", "description": "默认分组中文", "priority": 0}, token)
gid = js.get("data", {}).get("id")
check("create group", st == 201 and gid, (st, js))

st, js = call("GET", "/api/v1/groups", token=token)
row = next((g for g in js.get("data", []) if g["id"] == gid), {})
check("group stores UTF-8", row.get("description") == "默认分组中文", row)

st, js = call("POST", "/api/v1/groups", {"name": "default"}, token)
check("duplicate group name rejected", st in (400, 409), (st, js))

st, js = call("POST", "/api/v1/groups", {"name": "  "}, token)
check("empty group name rejected", st == 400, (st, js))

st, js = call("POST", "/api/v1/groups", {"name": "bad", "error_threshold": 5}, token)
check("out-of-range threshold rejected", st == 400, (st, js))

# --- accounts (upstream accounts now hold their own credentials) ---
st, js = call("POST", "/api/v1/accounts",
              {"name": "主账号", "provider": "openai", "api_key": "sk-SECRET-ACCOUNT",
               "group_id": gid, "base_url": "https://api.openai.com"}, token)
aid = js.get("data", {}).get("id")
check("create account", st == 201 and aid, (st, js))
check("account create masks key", js.get("data", {}).get("api_key") == "***", js.get("data"))
check("account exposes has_api_key", js.get("data", {}).get("has_api_key") is True, js.get("data"))

st, js = call("GET", "/api/v1/accounts", token=token)
check("account list masks key",
      all(a.get("api_key") in ("***", "") for a in js.get("data", [])), js.get("data"))

st, js = call("POST", "/api/v1/accounts",
              {"name": "bad-prov", "provider": "nope", "api_key": "sk-x", "group_id": gid}, token)
check("invalid provider rejected", st == 400, (st, js))

st, js = call("POST", "/api/v1/accounts",
              {"name": "bad-url", "provider": "openai", "api_key": "sk-x",
               "group_id": gid, "base_url": "notaurl"}, token)
check("invalid base_url rejected", st == 400, (st, js))

st, js = call("POST", "/api/v1/accounts",
              {"name": "nogroup", "provider": "openai", "api_key": "sk-x", "group_id": 9999}, token)
check("nonexistent group rejected", st == 400, (st, js))

st, js = call("POST", "/api/v1/accounts",
              {"name": "nofields", "provider": "openai", "api_key": "sk-x"}, token)
check("missing group rejected", st == 400, (st, js))

st, js = call("POST", "/api/v1/accounts",
              {"name": "keyless", "provider": "openai", "api_key": "", "group_id": gid}, token)
check("account without a key rejected", st == 400, (st, js))

st, js = call("POST", "/api/v1/accounts",
              {"name": "neg-rate", "provider": "openai", "api_key": "sk-x",
               "group_id": gid, "rate_multiplier": -1}, token)
check("negative multiplier rejected", st == 400, (st, js))

# --- model mappings ---
st, js = call("POST", "/api/v1/models",
              {"requested_model": "gpt-4o", "provider": "openai",
               "upstream_model": "gpt-4o-mini", "group_id": gid}, token)
check("create model mapping", st == 201, (st, js))

st, js = call("POST", "/api/v1/models",
              {"requested_model": "gpt-4o", "provider": "openai",
               "upstream_model": "x", "group_id": gid}, token)
check("duplicate mapping rejected", st in (400, 409), (st, js))

st, js = call("POST", "/api/v1/models",
              {"requested_model": "m", "provider": "openai",
               "upstream_model": "x", "group_id": 4242}, token)
check("mapping with bad group rejected", st == 400, (st, js))

st, js = call("POST", "/api/v1/models",
              {"requested_model": "claude-*", "provider": "anthropic",
               "upstream_model": "claude-3-5-sonnet-", "group_id": gid}, token)
check("wildcard mapping accepted", st == 201, (st, js))

st, js = call("POST", "/api/v1/models",
              {"requested_model": "gp*t", "provider": "openai",
               "upstream_model": "x", "group_id": gid}, token)
check("mid-string wildcard rejected", st == 400, (st, js))

# --- api keys ---
st, js = call("POST", "/api/v1/keys", {"name": "client-app", "quota_limit": 10}, token)
secret = js.get("data", {}).get("key", "")
kid = js.get("data", {}).get("id")
check("create api key returns secret once", secret.startswith("sk-") and kid, (st, js))

st, js = call("GET", "/api/v1/keys", token=token)
check("key list never returns secret",
      all("key" not in k and "key_hash" not in k for k in js.get("data", [])), js.get("data"))

st, js = call("PUT", "/api/v1/keys/%s" % kid, {"enabled": 0}, token)
check("toggle key", st == 200 and js.get("data", {}).get("enabled") == 0, (st, js))

# --- referential guards ---
st, js = call("DELETE", "/api/v1/groups/%s" % gid, token=token)
check("group delete blocked while in use", st in (400, 409), (st, js))

st, js = call("PUT", "/api/v1/accounts/%s" % aid, {"rate_multiplier": 0.5}, token)
check("account multiplier updatable", st == 200 and js.get("data", {}).get("rate_multiplier") == 0.5, (st, js))

# --- stats ---
st, js = call("GET", "/api/v1/stats?hours=24", token=token)
data = js.get("data", {})
check("stats endpoint responds", st == 200 and "totals" in data, (st, js))
check("stats counts resources", data.get("resources", {}).get("total_accounts", 0) >= 1,
      data.get("resources"))

# --- password change ---
st, js = call("POST", "/api/v1/auth/password",
              {"current_password": "nope", "new_password": "AnotherPass456"}, token)
check("password change needs current", st == 400 or st == 401, (st, js))

st, js = call("POST", "/api/v1/auth/password",
              {"current_password": "StrongPass123", "new_password": "AnotherPass456"}, token)
check("password change works", st == 200, (st, js))

st, js = call("POST", "/api/v1/auth/login", {"username": "admin", "password": "AnotherPass456"})
check("login with new password", st == 200 and js.get("token"), (st, js))

# --- gateway auth ---
st, js = call("POST", "/v1/chat/completions", {"model": "gpt-4o", "messages": []})
check("gateway rejects missing key", st == 401, (st, js))

passed = sum(1 for _, ok, _ in results if ok)
print("\nPASSED %d / %d" % (passed, len(results)))
if passed != len(results):
    print("FAILURES:")
    for label, ok, detail in results:
        if not ok:
            print("  - %s -> %s" % (label, detail))
