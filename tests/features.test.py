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
PORT_FAST, PORT_SLOW, PORT_FALLBACK = 9201, 9202, 9203

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
for port in (PORT_FAST, PORT_SLOW, PORT_FALLBACK):
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

# ------------------------------------------- primary group, then fallback group
# A key may name a second group used only after the primary one has nothing
# healthy left. The fallback must never win while the primary can still serve,
# otherwise a cheaper account in the fallback pool would quietly steal traffic.
_, fallback_account = call('/accounts', 'POST', {
    'name': 'feat-fallback', 'provider': 'openai', 'api_key': 'sk-fallback',
    'base_url': f'http://127.0.0.1:{PORT_FALLBACK}',
    'group_id': other_id, 'priority': 0, 'rate_multiplier': 0.1,
}, token=token)
fallback_account_id = fallback_account.get('data', {}).get('id')
check('fallback-group account created', bool(fallback_account_id), fallback_account.get('data'))

status, payload = call('/keys', 'POST', {
    'name': 'feat-fallback-key', 'group_id': primary_id, 'fallback_group_id': other_id,
}, token=token)
fallback_key = payload.get('data', {}).get('key')
check('key accepts a fallback group',
      status == 201 and payload.get('data', {}).get('fallback_group_id') == other_id,
      (status, payload.get('data')))

status, payload = call('/keys', 'POST', {
    'name': 'feat-same-group', 'group_id': primary_id, 'fallback_group_id': primary_id,
}, token=token)
check('fallback group cannot equal the primary group', status == 400, (status, payload))

# The fallback account is the cheapest of the three, so if tiering were ignored
# it would be picked first. The primary group must still answer.
for port in (PORT_FAST, PORT_SLOW, PORT_FALLBACK):
    control(port, reset=True, status=200, stream=False)
status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=fallback_key, base=BASE)
check('primary group answers while it is healthy',
      status == 200 and payload.get('id') == f'chatcmpl-{PORT_FAST}', (status, payload.get('id')))
check('fallback upstream stayed untouched', len(seen(PORT_FALLBACK)) == 0, seen(PORT_FALLBACK))

# Disable both primary accounts: the tier is now empty, so the fallback group is
# the only place left to route. A config write also drops the routing snapshot,
# so this must take effect on the very next request.
call(f'/accounts/{cheap_id}', 'PUT', {'enabled': 0}, token=token)
call(f'/accounts/{pricey_id}', 'PUT', {'enabled': 0}, token=token)
for port in (PORT_FAST, PORT_SLOW, PORT_FALLBACK):
    control(port, reset=True, status=200, stream=False)
status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=fallback_key, base=BASE)
check('empty primary group falls back to the fallback group',
      status == 200 and payload.get('id') == f'chatcmpl-{PORT_FALLBACK}', (status, payload.get('id')))

# A key with no fallback group must fail rather than borrow another group.
status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=client_key, base=BASE)
check('key without a fallback group is still refused', status == 503, (status, payload))

call(f'/accounts/{cheap_id}', 'PUT', {'enabled': 1}, token=token)
call(f'/accounts/{pricey_id}', 'PUT', {'enabled': 1}, token=token)
call(f'/accounts/{fallback_account_id}', 'PUT', {'enabled': 0}, token=token)

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

# --------------------------------------------- probe uses a streaming request
# The gateway serves streaming traffic, and an upstream can accept a buffered
# request while failing to stream (a relay that never flushes, a plan without
# streaming rights). A non-streaming probe would call that account healthy.
control(PORT_FAST, reset=True, status=200)
call(f'/accounts/{cheap_id}/test', 'POST', {'model': 'gpt-5.5'}, token=token)
probe_requests = seen(PORT_FAST)
check('probe sends a streaming request',
      bool(probe_requests) and probe_requests[-1].get('stream') is True, probe_requests)
check('probe sends the selected model',
      bool(probe_requests) and probe_requests[-1].get('model') == 'gpt-5.5', probe_requests)

# ------------------------------------------------- cached upstream model list
status, payload = call(f'/accounts/{cheap_id}/models', token=token)
models = payload.get('data', {}).get('models', [])
check('upstream models listed', status == 200 and bool(models), (status, payload))
check('model list reports its freshness',
      'cached' in payload.get('data', {}), payload.get('data'))
check('model list reports the last probed model',
      payload.get('data', {}).get('probe_model') == 'gpt-5.5', payload.get('data'))

# The point of persisting the list: a second open must not re-hit the upstream.
control(PORT_FAST, reset=True, status=200)
status, payload = call(f'/accounts/{cheap_id}/models', token=token)
check('second listing is served from cache',
      payload.get('data', {}).get('cached') is True, payload.get('data'))
check('cached listing skips the upstream round trip', len(seen(PORT_FAST)) == 0, seen(PORT_FAST))

# An explicit refresh must still reach the upstream, or a genuinely changed
# catalogue could never be relearned.
status, payload = call(f'/accounts/{cheap_id}/models?refresh=1', token=token)
check('refresh re-fetches from the upstream',
      payload.get('data', {}).get('cached') is False and len(seen(PORT_FAST)) >= 1,
      (payload.get('data'), seen(PORT_FAST)))

status, _ = call(f'/accounts/{cheap_id}/models')
check('model listing requires auth', status == 401, status)

# ------------------------------------ batch probe is driven by the provider
# Batch probing is the keep-alive path. The model comes from the account's
# provider, not from whatever an operator last probed with: a one-off manual test
# against an unusual model must not silently become what every later keep-alive
# run sends, and two accounts on the same provider should never be checked
# against different models for no visible reason.
control(PORT_FAST, reset=True, status=200)
status, payload = call('/accounts/test-all', 'POST', {'group_ids': [primary_id]}, token=token)
data = payload.get('data', {})
check('batch probe accepts a group', status == 200, (status, payload))
check('batch probe reports the groups it covered', data.get('group_ids') == [primary_id], data)
batch_requests = seen(PORT_FAST)
check('batch probe streams', bool(batch_requests) and batch_requests[-1].get('stream') is True,
      batch_requests)
check('batch probe uses the openai provider default',
      bool(batch_requests) and batch_requests[-1].get('model') == 'gpt-5.6-terra', batch_requests)
check('batch probe names the model per row',
      bool(data.get('results')) and data['results'][0].get('model') == 'gpt-5.6-terra',
      data.get('results'))
check('batch probe attributes each row to its group',
      bool(data.get('results')) and data['results'][0].get('group_id') == primary_id,
      data.get('results'))

# A manual probe against an unusual model must not change what keep-alive sends.
control(PORT_FAST, reset=True, status=200)
call(f'/accounts/{cheap_id}/test', 'POST', {'model': 'gpt-5.5-pro'}, token=token)
control(PORT_FAST, reset=True, status=200)
call('/accounts/test-all', 'POST', {'group_ids': [primary_id]}, token=token)
after_manual = seen(PORT_FAST)
check('a manual probe does not hijack later keep-alive runs',
      bool(after_manual) and all(entry.get('model') == 'gpt-5.6-terra' for entry in after_manual),
      [entry.get('model') for entry in after_manual])

# Per-provider override, so an operator can probe a whole run with one model
# without editing every account.
control(PORT_FAST, reset=True, status=200)
status, payload = call('/accounts/test-all', 'POST',
                       {'group_ids': [primary_id], 'models': {'openai': 'gpt-5.6-luna'}},
                       token=token)
overridden = seen(PORT_FAST)
check('a provider override replaces the default',
      bool(overridden) and overridden[-1].get('model') == 'gpt-5.6-luna', overridden)

status, payload = call('/accounts/test-all', 'POST',
                       {'group_ids': [primary_id], 'models': {'nonsense': 'x'}}, token=token)
check('an unknown provider override is rejected', status == 400, (status, payload))

# Several groups at once: the usual case is keeping a few named pools warm.
call(f'/accounts/{fallback_account_id}', 'PUT', {'enabled': 1}, token=token)
control(PORT_FAST, reset=True, status=200)
control(PORT_FALLBACK, reset=True, status=200)
status, payload = call('/accounts/test-all', 'POST',
                       {'group_ids': [primary_id, other_id]}, token=token)
data = payload.get('data', {})
covered = {row.get('group_id') for row in data.get('results', [])}
check('multiple groups can be probed in one run', status == 200, (status, payload))
check('every selected group is covered', covered == {primary_id, other_id}, covered)
check('both upstreams were actually probed',
      len(seen(PORT_FAST)) >= 1 and len(seen(PORT_FALLBACK)) >= 1,
      (len(seen(PORT_FAST)), len(seen(PORT_FALLBACK))))

# A duplicate id is an operator slip, not a reason to probe an account twice.
control(PORT_FAST, reset=True, status=200)
status, payload = call('/accounts/test-all', 'POST',
                       {'group_ids': [primary_id, primary_id]}, token=token)
check('a repeated group is only probed once',
      payload.get('data', {}).get('group_ids') == [primary_id], payload.get('data'))

# One selected group being empty must be reported rather than silently skipped.
_, empty_group = call('/groups', 'POST', {'name': 'feat-empty', 'priority': 9}, token=token)
empty_id = empty_group.get('data', {}).get('id')
status, payload = call('/accounts/test-all', 'POST', {'group_ids': [empty_id]}, token=token)
check('batch probe rejects a group with no accounts', status == 400, (status, payload))

status, payload = call('/accounts/test-all', 'POST', {'group_ids': [999999]}, token=token)
check('batch probe rejects an unknown group', status == 400, (status, payload))

# No selection at all means every enabled account, which is what the "all"
# checkbox sends.
status, payload = call('/accounts/test-all', 'POST', {'group_ids': []}, token=token)
check('an empty selection probes every enabled account',
      status == 200 and payload.get('data', {}).get('group_ids') is None,
      (status, payload.get('data', {}).get('group_ids')))

# The older single-group body must keep working: a saved keep-alive caller
# should not break because the console gained checkboxes.
status, payload = call('/accounts/test-all', 'POST', {'group_id': primary_id}, token=token)
check('the single-group request shape still works',
      status == 200 and payload.get('data', {}).get('group_id') == primary_id,
      (status, payload.get('data')))

status, payload = call('/accounts/test-all', 'POST', {'group_id': 'all'}, token=token)
check('batch probe still supports every account', status == 200, (status, payload))

call(f'/accounts/{fallback_account_id}', 'PUT', {'enabled': 0}, token=token)

# ------------------------------------------------------- usage record cleanup
# D1 caps database size and usage_records is the only table that grows with
# traffic, so an operator needs to reclaim it without shell access.
_, usage_before = call('/usage?limit=50', token=token)
rows = usage_before.get('data', [])
check('usage rows exist before cleanup', bool(rows), len(rows))

first_id = rows[0].get('id') if rows else 0
status, payload = call(f'/usage/{first_id}', 'DELETE', token=token)
check('single usage record deleted', status == 200 and payload.get('success') is True,
      (status, payload))

_, usage_after = call('/usage?limit=50', token=token)
check('deleted row is gone',
      all(row.get('id') != first_id for row in usage_after.get('data', [])),
      [row.get('id') for row in usage_after.get('data', [])])

status, payload = call(f'/usage/{first_id}', 'DELETE', token=token)
check('deleting a missing record is reported', status == 404, (status, payload))

# A bulk delete without a window would be an unguarded "drop everything".
status, payload = call('/usage', 'DELETE', token=token)
check('bulk cleanup requires a retention window', status == 400, (status, payload))

status, payload = call('/usage?older_than_days=abc', 'DELETE', token=token)
check('bulk cleanup validates the window', status == 400, (status, payload))

# A 3650-day window keeps everything, which proves the endpoint honours the
# cutoff instead of always truncating the table.
status, payload = call('/usage?older_than_days=3650', 'DELETE', token=token)
_, kept = call('/usage?limit=50', token=token)
check('a wide window keeps recent rows', status == 200 and bool(kept.get('data')),
      (status, payload, len(kept.get('data', []))))

status, payload = call('/usage?older_than_days=0', 'DELETE', token=token)
_, emptied = call('/usage?limit=50', token=token)
check('zero days clears every row',
      status == 200 and not emptied.get('data'), (status, payload, emptied.get('data')))

status, _ = call('/usage?older_than_days=0', 'DELETE')
check('usage cleanup requires auth', status == 401, status)

# ------------------------------------------------- error-rate circuit breaking
# Failing over on a single request is not the same as circuit breaking. Once an
# account has crossed its group's error threshold it must be taken out of
# rotation *before* the next request is attempted, otherwise every caller keeps
# paying the latency of a known-dead upstream first.
_, breaker = call('/groups', 'POST', {
    'name': 'feat-breaker', 'priority': 0,
    'error_threshold': 0.5, 'error_count_threshold': 2, 'window_seconds': 300,
}, token=token)
breaker_id = breaker.get('data', {}).get('id')
check('breaker group stores its thresholds',
      breaker.get('data', {}).get('error_count_threshold') == 2, breaker.get('data'))

_, broken = call('/accounts', 'POST', {
    'name': 'feat-broken', 'provider': 'openai', 'api_key': 'sk-broken',
    'base_url': f'http://127.0.0.1:{PORT_SLOW}',
    'group_id': breaker_id, 'priority': 0,
}, token=token)
broken_id = broken.get('data', {}).get('id')

_, spare = call('/accounts', 'POST', {
    'name': 'feat-spare', 'provider': 'openai', 'api_key': 'sk-spare',
    'base_url': f'http://127.0.0.1:{PORT_FALLBACK}',
    'group_id': breaker_id, 'priority': 5,
}, token=token)
check('breaker fixtures created', bool(broken_id) and bool(spare.get('data', {}).get('id')),
      (broken_id, spare.get('data')))

_, breaker_key_payload = call('/keys', 'POST',
                              {'name': 'feat-breaker-key', 'group_id': breaker_id}, token=token)
breaker_key = breaker_key_payload.get('data', {}).get('key')

# The preferred account fails; the spare answers. Each attempt writes a request
# log, which is what the breaker reads.
call(f'/accounts/{fallback_account_id}', 'PUT', {'enabled': 1}, token=token)
control(PORT_SLOW, reset=True, status=500, stream=False)
control(PORT_FALLBACK, reset=True, status=200, stream=False)

for _ in range(3):
    status, payload = call('/v1/chat/completions', 'POST',
                           {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                           token=breaker_key, base=BASE)
check('failover still answers while the preferred account is down',
      status == 200 and payload.get('id') == f'chatcmpl-{PORT_FALLBACK}',
      (status, payload.get('id')))
# Exactly one attempt is the correct number, not a floor. error_threshold is 0.5
# and one failure out of one request is a 100% error rate, so the breaker opens
# after the very first failure and error_count_threshold never becomes the
# binding condition. Asserting on ">= 2 attempts" would demand that the gateway
# keep paying for a known-dead upstream.
check('the broken upstream was attempted exactly once', len(seen(PORT_SLOW)) == 1, len(seen(PORT_SLOW)))

# Let the deferred request_logs writes land, then heal the broken upstream. A
# request must still skip it: the error window has not expired, so the breaker
# is what decides, not the upstream's current mood.
time.sleep(1.5)
control(PORT_SLOW, reset=True, status=200, stream=False)
control(PORT_FALLBACK, reset=True, status=200, stream=False)
status, payload = call('/v1/chat/completions', 'POST',
                       {'model': 'gpt-4o', 'messages': [{'role': 'user', 'content': 'hi'}]},
                       token=breaker_key, base=BASE)
check('a tripped breaker diverts to the healthy account',
      status == 200 and payload.get('id') == f'chatcmpl-{PORT_FALLBACK}',
      (status, payload.get('id')))
check('the circuit-broken account is not attempted at all',
      len(seen(PORT_SLOW)) == 0, seen(PORT_SLOW))

# ------------------------------------------------------------------- teardown
print()
print(f'PASSED {passed} / {passed + len(failures)}')
if failures:
    print('FAILURES:')
    for failure in failures:
        print(' -', failure)
    sys.exit(1)
