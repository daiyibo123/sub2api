"""Tests for the features added after the first release.

Covers time-to-first-token capture, streaming usage records, rate-multiplier
ordering, upstream liveness probing and API-key group pinning. Run with the dev
server up and a clean database:

  npx wrangler pages dev frontend --port 8788 --persist-to .wrangler/devstate
  python tests/features.test.py
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from upstream_stub import serve  # noqa: E402

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8788'
API = f'{BASE}/api/v1'
ADMIN = ('admin', 'StrongPass123')
PORT_FAST, PORT_SLOW = 9201, 9202

passed = 0
failures = []


def check(name, ok, detail=''):
    global passed
    if ok:
        passed += 1
        print('PASS', name)
    else:
        failures.append(f'{name} -> {detail}')
        print('FAIL', name, detail)


def call(path, method='GET', body=None, token=None, base=API, headers=None):
    url = path if path.startswith('http') else f'{base}{path}'
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    if data:
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
            except json.JSONDecodeError:
                return response.status, {'raw': raw}
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        try:
            return error.code, json.loads(raw)
        except json.JSONDecodeError:
            return error.code, {'raw': raw}


def control(port, **config):
    call(f'http://127.0.0.1:{port}/__control', 'POST', config, base='')


def seen(port):
    _, payload = call(f'http://127.0.0.1:{port}/__control', 'GET', base='')
    return payload.get('requests', [])


# ------------------------------------------------------------------ fixtures
for port in (PORT_FAST, PORT_SLOW):
    serve(port)
time.sleep(0.4)

call('/auth/setup', 'POST', {'username': ADMIN[0], 'password': ADMIN[1]})
_, login = call('/auth/login', 'POST', {'username': ADMIN[0], 'password': ADMIN[1]})
token = login.get('token')
check('admin login', bool(token))

_, primary = call('/groups', 'POST', {'name': 'feat-primary', 'priority': 0}, token=token)
_, other = call('/groups', 'POST', {'name': 'feat-other', 'priority': 0}, token=token)
primary_id = primary.get('data', {}).get('id')
other_id = other.get('data', {}).get('id')

# Two accounts at equal priority, differing only in billing weight.
_, fast = call('/accounts', 'POST', {
    'name': 'feat-cheap', 'provider': 'openai', 'api_key': 'sk-cheap',
    'base_url': f'http://127.0.0.1:{PORT_FAST}',
    'group_id': primary_id, 'priority': 0, 'rate_multiplier': 0.5,
}, token=token)
cheap_id = fast.get('data', {}).get('id')
check('account accepts rate_multiplier', fast.get('data', {}).get('rate_multiplier') is not None,
      fast.get('data'))

status, payload = call('/accounts', 'POST', {
    'name': 'feat-negative', 'provider': 'openai', 'api_key': 'sk-x',
    'group_id': primary_id, 'rate_multiplier': -1,
}, token=token)
check('negative multiplier rejected', status == 400, (status, payload))

status, payload = call('/accounts', 'POST', {
    'name': 'feat-huge', 'provider': 'openai', 'api_key': 'sk-x',
    'group_id': primary_id, 'rate_multiplier': 5000,
}, token=token)
check('absurd multiplier rejected', status == 400, (status, payload))

_, slow = call('/accounts', 'POST', {
    'name': 'feat-pricey', 'provider': 'openai', 'api_key': 'sk-pricey',
    'base_url': f'http://127.0.0.1:{PORT_SLOW}',
    'group_id': primary_id, 'priority': 0, 'rate_multiplier': 3,
}, token=token)
pricey_id = slow.get('data', {}).get('id')

check('account stores multiplier', float(slow.get('data', {}).get('rate_multiplier') or 0) == 3,
      slow.get('data'))
check('both accounts created', bool(cheap_id) and bool(pricey_id), (cheap_id, pricey_id))

_, key_payload = call('/keys', 'POST', {'name': 'feat-key', 'group_id': primary_id}, token=token)
client_key = key_payload.get('data', {}).get('key')
check('key created with group', bool(client_key) and key_payload.get('data', {}).get('group_id') == primary_id,
      key_payload.get('data'))

control(PORT_FAST, reset=True, status=200)
control(PORT_SLOW, reset=True, status=200)
status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=client_key, base=BASE)
check('request succeeded', status == 200, (status, payload))
check('cheaper account chosen at equal priority',
      payload.get('id') == f'chatcmpl-{PORT_FAST}', payload.get('id'))

# Priority must still outrank cost: make the expensive account higher priority.
call(f'/accounts/{pricey_id}', 'PUT', {'priority': -5}, token=token)
control(PORT_FAST, reset=True)
control(PORT_SLOW, reset=True)
status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=client_key, base=BASE)
check('priority still outranks cost',
      payload.get('id') == f'chatcmpl-{PORT_SLOW}', payload.get('id'))
call(f'/accounts/{pricey_id}', 'PUT', {'priority': 0}, token=token)

# ------------------------------------------------ key group pinning is a wall
_, foreign = call('/keys', 'POST', {'name': 'feat-foreign', 'group_id': other_id}, token=token)
foreign_key = foreign.get('data', {}).get('key')
status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=foreign_key, base=BASE)
check('key pinned to empty group is refused', status == 503, (status, payload))
# The message is user-facing Chinese, so assert on what it actually says.
check('refusal explains the group has no accounts',
      '分组' in json.dumps(payload, ensure_ascii=False), payload)

status, payload = call('/keys', 'POST', {'name': 'feat-bad-group', 'group_id': 999999}, token=token)
check('key with unknown group rejected', status == 400, (status, payload))

# ------------------------------------------------------ TTFT + stream records
control(PORT_FAST, reset=True, status=200, stream=True)
control(PORT_SLOW, reset=True, status=200)
request = urllib.request.Request(f'{BASE}/v1/chat/completions', method='POST',
                                 data=json.dumps({'model': 'gpt-4o', 'stream': True,
                                                  'messages': [{'role': 'user', 'content': 'hi'}]}).encode())
request.add_header('content-type', 'application/json')
request.add_header('authorization', f'Bearer {client_key}')
with urllib.request.urlopen(request, timeout=30) as response:
    content_type = response.headers.get('content-type', '')
    stream_body = response.read().decode()
check('stream returns SSE', 'text/event-stream' in content_type, content_type)
check('stream carries frames', 'data:' in stream_body, stream_body[:60])

# The record is written from the stream completion callback, so allow a moment.
time.sleep(1.5)
_, usage = call('/usage?limit=20', token=token)
records = usage.get('data', [])
check('streaming wrote a usage record', bool(records), len(records))

streamed = records[0] if records else {}
check('streaming record has ttft', streamed.get('ttft_ms') is not None, streamed.get('ttft_ms'))
check('streaming record has latency', bool(streamed.get('latency_ms')), streamed.get('latency_ms'))
check('streaming record counted tokens',
      (streamed.get('total_tokens') or 0) > 0, streamed.get('total_tokens'))

# Attribution: a record that cannot name its group or account cannot be
# filtered by one, which is the whole point of the console toolbars.
check('streaming record names its group',
      streamed.get('group_id') == primary_id, streamed.get('group_id'))
check('streaming record names its account',
      bool(streamed.get('account_id')), streamed.get('account_id'))
check('streaming record joins the group name',
      streamed.get('group_name') == 'feat-primary', streamed.get('group_name'))
check('streaming record joins the account name',
      bool(streamed.get('account_name')), streamed.get('account_name'))
check('streaming record joins the key name',
      streamed.get('key_name') == 'feat-key', streamed.get('key_name'))

# Non-streaming should also carry ttft (measured as full response time).
control(PORT_FAST, reset=True, status=200, stream=False)
call('/v1/chat/completions', 'POST',
     {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
     token=client_key, base=BASE)
time.sleep(0.8)
_, usage2 = call('/usage?limit=5', token=token)
check('non-streaming record exists', bool(usage2.get('data')), usage2.get('data'))
plain = (usage2.get('data') or [{}])[0]
check('non-streaming record is also attributed',
      plain.get('group_id') == primary_id and bool(plain.get('account_id')),
      (plain.get('group_id'), plain.get('account_id')))

# ------------------------------------------------------------- health probing
control(PORT_FAST, reset=True, status=200)
status, payload = call(f'/accounts/{cheap_id}/test', 'POST', token=token)
check('single probe succeeds', payload.get('success') is True, payload)
check('probe reports latency', payload.get('latency_ms') is not None, payload)

_, accounts = call('/accounts', token=token)
probed = next((a for a in accounts.get('data', []) if a.get('id') == cheap_id), {})
check('probe result persisted', probed.get('last_check_at') is not None, probed.get('last_check_at'))
check('probe stored verdict', probed.get('last_check_ok') is not None, probed.get('last_check_ok'))
check('probe never leaks key', probed.get('api_key') in ('***', ''), probed.get('api_key'))

control(PORT_SLOW, reset=True, status=500)
status, payload = call(f'/accounts/{pricey_id}/test', 'POST', token=token)
check('failing probe reports failure', payload.get('success') is False, payload)

status, payload = call('/accounts/test-all', 'POST', token=token)
data = payload.get('data', {})
check('batch probe runs', status == 200 and data.get('total', 0) >= 2, (status, payload))
check('batch probe counts healthy', data.get('healthy', -1) >= 1, data)
check('batch probe counts failures', data.get('failed', -1) >= 1, data)
check('batch probe returns per-account rows', len(data.get('results', [])) == data.get('total'), data)

status, payload = call('/accounts/999999/test', 'POST', token=token)
check('probe of unknown account is reported', payload.get('success') is False, payload)

# Probing must stay behind auth.
status, _ = call('/accounts/test-all', 'POST')
check('batch probe requires auth', status == 401, status)

# ------------------------------------------------------------------- teardown
print()
print(f'PASSED {passed} / {passed + len(failures)}')
if failures:
    print('FAILURES:')
    for failure in failures:
        print(' -', failure)
    sys.exit(1)
