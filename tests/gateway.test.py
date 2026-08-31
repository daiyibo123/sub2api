"""End-to-end gateway tests: routing, model mapping, scheduling, failover.

Runs against `wrangler pages dev` with fake upstream providers, so it exercises
the real worker code path (auth -> mapping -> account selection -> proxy ->
failover -> usage logging) rather than mocking it.

Usage:
  python tests/gateway.test.py [base_url]
"""
import json
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, 'tests')
from upstream_stub import serve  # noqa: E402

BASE = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8788').rstrip('/')
API = f'{BASE}/api/v1'
ADMIN = ('gwadmin', 'gateway-pass-9911')

PORT_A, PORT_B, PORT_C = 9101, 9102, 9103

passed = 0
failures = []


def check(name, ok, detail=''):
    global passed
    if ok:
        passed += 1
        print('PASS', name)
    else:
        failures.append(f'{name} {detail}')
        print('FAIL', name, detail)


def call(path, method='GET', body=None, token=None, headers=None, base=API):
    url = path if path.startswith('http') else base + path
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header('content-type', 'application/json')
    if token:
        request.add_header('authorization', f'Bearer {token}')
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode()
            try:
                return response.status, json.loads(raw)
            except Exception:
                return response.status, {'raw': raw}
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        try:
            return error.code, json.loads(raw)
        except Exception:
            return error.code, {'raw': raw}


def control(port, **config):
    call(f'http://127.0.0.1:{port}/__control', 'POST', config, base='')


def requests_seen(port):
    _, payload = call(f'http://127.0.0.1:{port}/__control', 'GET', base='')
    return payload.get('requests', [])


def all_requests_seen():
    """Requests observed on any stub, in call order.

    Which account the scheduler picks depends on live error history, so tests
    that only care about the forwarded payload must not pin a single port.
    """
    collected = []
    for port in (PORT_A, PORT_B, PORT_C):
        collected.extend(requests_seen(port))
    return collected


def reset_upstreams():
    for port in (PORT_A, PORT_B, PORT_C):
        control(port, reset=True, status=200, stream=False)


# ---------------------------------------------------------------- fixtures
for port in (PORT_A, PORT_B, PORT_C):
    serve(port)
time.sleep(0.4)
print(f'stub upstreams ready on {PORT_A}, {PORT_B}, {PORT_C}')

call('/auth/setup', 'POST', {'username': ADMIN[0], 'password': ADMIN[1]})
status, payload = call('/auth/login', 'POST', {'username': ADMIN[0], 'password': ADMIN[1]})
token = payload.get('token')
check('admin login', bool(token), payload)
if not token:
    raise SystemExit('cannot continue without an admin token')

# Two groups: primary (priority 0) and backup (priority 10).
_, primary = call('/groups', 'POST', {'name': 'gw-primary', 'priority': 0, 'error_count_threshold': 3}, token=token)
_, backup = call('/groups', 'POST', {'name': 'gw-backup', 'priority': 10, 'error_count_threshold': 3}, token=token)
primary_id = primary.get('data', {}).get('id')
backup_id = backup.get('data', {}).get('id')

# Accounts now carry their own base_url and key; there is no channel layer.
account_ids = {}
for name, port, priority, group in (
    ('gw-a', PORT_A, 0, 'primary'),
    ('gw-b', PORT_B, 5, 'primary'),
    ('gw-c', PORT_C, 0, 'backup'),
):
    _, created = call('/accounts', 'POST', {
        'name': name, 'provider': 'openai', 'api_key': f'sk-account-{name}',
        'base_url': f'http://127.0.0.1:{port}',
        'group_id': primary_id if group == 'primary' else backup_id,
        'priority': priority,
    }, token=token)
    account_ids[name] = created.get('data', {}).get('id')

check('fixtures created', bool(primary_id and backup_id), f'groups={primary_id},{backup_id}')
check('three accounts created', all(account_ids.values()), account_ids)

_, key_payload = call('/keys', 'POST', {'name': 'gw-key', 'quota_limit': 0}, token=token)
client_key = key_payload.get('data', {}).get('key')
check('client api key issued', bool(client_key))

# ------------------------------------------------------- gateway auth gate
status, _ = call('/v1/chat/completions', 'POST', {'model': 'gpt-4o', 'messages': []}, base=BASE)
check('gateway rejects missing key', status == 401, status)

status, _ = call('/v1/chat/completions', 'POST', {'model': 'gpt-4o', 'messages': []},
                 token='sk-not-a-real-key', base=BASE)
check('gateway rejects unknown key', status == 401, status)

# --------------------------------------------------- happy path + priority
reset_upstreams()
status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=client_key, base=BASE)
check('chat completion succeeds', status == 200, (status, payload))
check('response came from priority-0 account', payload.get('id') == f'chatcmpl-{PORT_A}', payload.get('id'))
check('only the selected upstream was called', len(requests_seen(PORT_A)) == 1 and not requests_seen(PORT_B))

seen = requests_seen(PORT_A)[0]
check('account key forwarded to upstream', seen['authorization'] == 'Bearer sk-account-gw-a', seen['authorization'])

# Failover must forward the next account's own credential.
reset_upstreams()
control(PORT_A, status=500)
status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=client_key, base=BASE)
check('failover produced a success', status == 200, (status, payload))
check('failover used the next account', payload.get('id') == f'chatcmpl-{PORT_B}', payload.get('id'))
b_seen = requests_seen(PORT_B)
check('account key forwarded on failover', bool(b_seen) and b_seen[0]['authorization'] == 'Bearer sk-account-gw-b',
      b_seen[0]['authorization'] if b_seen else None)

# 400 is a caller error and must NOT trigger failover.
reset_upstreams()
control(PORT_A, status=400)
status, _ = call('/v1/chat/completions', 'POST',
                 {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                 token=client_key, base=BASE)
check('client error passes through', status == 400, status)
check('client error did not failover', len(requests_seen(PORT_B)) == 0, requests_seen(PORT_B))

# 429 should trigger failover.
reset_upstreams()
control(PORT_A, status=429)
status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=client_key, base=BASE)
check('rate limit triggers failover', status == 200 and payload.get('id') == f'chatcmpl-{PORT_B}',
      (status, payload.get('id')))

# Account-level 4xx must switch accounts too. An expired key (401), an unpaid
# balance (402), a plan without access (403) and an upstream that does not serve
# the model (404) all describe the *credential*, not the request, so another
# account can serve them. Returning them to the caller left the dead account in
# rotation and made the gateway look broken.
#
# The assertion is that the caller never sees the upstream's status: whichever
# account is picked first, the answer must come from a working one. Checking the
# reply's origin rather than which port was touched keeps this stable even once
# the error window has circuit-broken the failing account.
for code in (401, 402, 403, 404, 409, 500, 502, 503, 529):
    reset_upstreams()
    control(PORT_A, status=code)
    status, payload = call('/v1/chat/completions', 'POST',
                           {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                           token=client_key, base=BASE)
    check(f'HTTP {code} switches accounts instead of reaching the client',
          status == 200 and payload.get('id') != f'chatcmpl-{PORT_A}',
          (status, payload.get('id')))

# The other half of the rule: a 4xx that describes the request must NOT be
# replayed. Retrying it produces the identical error on every account while
# burning each one's quota, so every upstream is set to the same status and the
# test asserts a single attempt was made in total.
for code in (400, 413, 422):
    reset_upstreams()
    for port in (PORT_A, PORT_B, PORT_C):
        control(port, status=code)
    status, _ = call('/v1/chat/completions', 'POST',
                     {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                     token=client_key, base=BASE)
    attempts = sum(len(requests_seen(port)) for port in (PORT_A, PORT_B, PORT_C))
    check(f'HTTP {code} is returned to the client', status == code, status)
    check(f'HTTP {code} is not replayed on another account', attempts == 1, attempts)

# Both primary accounts down -> must fall through to the backup group.
reset_upstreams()
control(PORT_A, status=500)
control(PORT_B, status=503)
status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=client_key, base=BASE)
check('falls through to backup group', status == 200 and payload.get('id') == f'chatcmpl-{PORT_C}',
      (status, payload.get('id')))

# Every upstream down -> a single clear error, not a hang.
reset_upstreams()
for port in (PORT_A, PORT_B, PORT_C):
    control(port, status=500)
status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=client_key, base=BASE)
check('all accounts failed reports an error', status >= 500, (status, payload))

# ------------------------------------------------------------ model mapping
reset_upstreams()
call('/models', 'POST', {
    'requested_model': 'fast', 'provider': 'openai',
    'upstream_model': 'gpt-4o-mini', 'group_id': primary_id,
}, token=token)
status, _ = call('/v1/chat/completions', 'POST',
                 {'model': 'fast', 'messages': [{'role': 'user', 'content': 'hi'}]},
                 token=client_key, base=BASE)
mapped = all_requests_seen()
check('mapped model rewritten upstream',
      status == 200 and bool(mapped) and mapped[0]['model'] == 'gpt-4o-mini',
      mapped[0]['model'] if mapped else None)

# Wildcard mapping: claude-* -> the upstream prefix plus the caller's suffix.
reset_upstreams()
call('/models', 'POST', {
    'requested_model': 'legacy-*', 'provider': 'openai',
    'upstream_model': 'gpt-4o-', 'group_id': primary_id,
}, token=token)
status, _ = call('/v1/chat/completions', 'POST',
                 {'model': 'legacy-turbo', 'messages': [{'role': 'user', 'content': 'hi'}]},
                 token=client_key, base=BASE)
wild = all_requests_seen()
check('wildcard mapping expands suffix',
      status == 200 and bool(wild) and wild[0]['model'] == 'gpt-4o-turbo',
      wild[0]['model'] if wild else None)

# ---------------------------------------------------------------- streaming
reset_upstreams()
request = urllib.request.Request(f'{BASE}/v1/chat/completions', method='POST',
                                 data=json.dumps({'model': 'gpt-4o', 'stream': True,
                                                  'messages': [{'role': 'user', 'content': 'hi'}]}).encode())
request.add_header('content-type', 'application/json')
request.add_header('authorization', f'Bearer {client_key}')
with urllib.request.urlopen(request, timeout=30) as response:
    content_type = response.headers.get('content-type', '')
    stream_body = response.read().decode()
check('stream keeps SSE content type', 'text/event-stream' in content_type, content_type)
check('stream body carries sse frames', 'data:' in stream_body, stream_body[:80])
stream_seen = all_requests_seen()
check('upstream saw stream flag', bool(stream_seen) and stream_seen[0]['stream'] is True)

# ----------------------------------------------------- anthropic + messages
call('/accounts', 'POST', {
    'name': 'gw-anthropic-acct', 'provider': 'anthropic', 'api_key': 'sk-anthropic-acct',
    'base_url': f'http://127.0.0.1:{PORT_C}',
    'group_id': primary_id, 'client_spoofing': 'claude-code',
}, token=token)

reset_upstreams()
status, payload = call('/v1/messages', 'POST',
                       {'model': 'claude-3-5-sonnet-20241022', 'max_tokens': 32,
                        'messages': [{'role': 'user', 'content': 'hi'}]},
                       headers={'x-api-key': client_key, 'anthropic-version': '2023-06-01'},
                       base=BASE)
check('anthropic messages route works', status == 200, (status, payload))
claude_seen = requests_seen(PORT_C)
check('anthropic used x-api-key header',
      bool(claude_seen) and claude_seen[0]['x_api_key'] == 'sk-anthropic-acct',
      claude_seen[0]['x_api_key'] if claude_seen else None)
check('anthropic version header forwarded',
      bool(claude_seen) and claude_seen[0]['anthropic_version'] == '2023-06-01',
      claude_seen[0]['anthropic_version'] if claude_seen else None)
check('client spoofing applied',
      bool(claude_seen) and 'claude-cli' in (claude_seen[0]['user_agent'] or ''),
      claude_seen[0]['user_agent'] if claude_seen else None)
check('anthropic hit the messages path',
      bool(claude_seen) and '/v1/messages' in claude_seen[0]['path'],
      claude_seen[0]['path'] if claude_seen else None)

# --------------------------------------------------- disabled account skip
reset_upstreams()
call(f'/accounts/{account_ids["gw-a"]}', 'PUT', {'enabled': 0}, token=token)
status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=client_key, base=BASE)
check('disabled account is skipped',
      status == 200 and payload.get('id') != f'chatcmpl-{PORT_A}' and not requests_seen(PORT_A),
      (status, payload.get('id')))
call(f'/accounts/{account_ids["gw-a"]}', 'PUT', {'enabled': 1}, token=token)

# ------------------------------------------------------ usage + model probe
status, payload = call('/v1/models', token=client_key, base=BASE)
check('models probe lists ids', status == 200 and bool(payload.get('data')), status)

status, payload = call('/usage?limit=200', token=token)
records = payload.get('data', [])
check('usage records were written', status == 200 and len(records) > 0, len(records))
check('usage captured token counts', any(num for num in (r.get('total_tokens') or 0 for r in records) if num > 0))
check('usage captured latency', any((r.get('latency_ms') or 0) > 0 for r in records))

status, payload = call('/stats?hours=24', token=token)
totals = payload.get('data', {}).get('totals', {})
check('stats aggregates requests', status == 200 and int(totals.get('total_requests') or 0) > 0,
      totals.get('total_requests'))

# ------------------------------------------------------- connection tester
reset_upstreams()
status, payload = call(f'/accounts/{account_ids["gw-a"]}/test', 'POST', token=token)
check('account connection test succeeds', status == 200 and payload.get('success') is True, payload)

control(PORT_A, status=401)
status, payload = call(f'/accounts/{account_ids["gw-a"]}/test', 'POST', token=token)
check('account connection test reports failure', status == 200 and payload.get('success') is False, payload)

print()
print(f'PASSED {passed} / {passed + len(failures)}')
if failures:
    print('FAILURES:')
    for failure in failures:
        print(' -', failure)
    raise SystemExit(1)
