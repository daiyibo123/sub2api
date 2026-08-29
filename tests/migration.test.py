"""Verify the channel-to-account fold on a database that predates the change.

The live deployment already has a `channels` table, accounts whose api_key is
blank (inheriting the channel credential), and possibly accounts sitting under a
disabled channel. Dropping the channel layer without carrying those facts across
would silently break real traffic, so this builds an old-shape database by hand
and asserts the migration preserves every one of them.

Usage:
  # 1. seed, with the dev server STOPPED
  python tests/migration.test.py <path-to-d1-sqlite-file>
  # 2. start the dev server, then
  MIGRATION_PHASE=verify python tests/migration.test.py <same-path>

The path is the hash-named file under
.wrangler/state/v3/d1/miniflare-D1DatabaseObject/, not metadata.sqlite — that
one is miniflare's own bookkeeping and seeding it tests nothing.

The caller is responsible for stopping the dev server first: miniflare holds the
file open and its shutdown checkpoint would overwrite external writes.
"""
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request

BASE = 'http://127.0.0.1:8788/api/v1'
ADMIN = ('admin', 'MigratePass123')

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


def call(path, method='GET', body=None, token=None, base=BASE):
    request = urllib.request.Request(f'{base}{path}', method=method)
    request.add_header('content-type', 'application/json')
    if token:
        request.add_header('authorization', f'Bearer {token}')
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(request, data, timeout=30) as response:
            raw = response.read().decode()
            return response.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        try:
            return error.code, json.loads(raw)
        except Exception:
            return error.code, {'raw': raw}


def seed_old_shape(db_path):
    """Create the pre-fold schema and rows that the migration must rescue."""
    connection = sqlite3.connect(db_path)
    connection.executescript("""
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      enabled INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 0,
      error_threshold REAL DEFAULT 0.5,
      error_count_threshold INTEGER DEFAULT 5,
      window_seconds INTEGER DEFAULT 300,
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL,
      base_url TEXT,
      api_key TEXT,
      enabled INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 0,
      rate_multiplier REAL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      api_key TEXT NOT NULL,
      base_url TEXT,
      group_id INTEGER NOT NULL,
      channel_id INTEGER NOT NULL,
      enabled INTEGER DEFAULT 1,
      error_count INTEGER DEFAULT 0,
      error_rate REAL DEFAULT 0,
      last_error_at TEXT,
      last_error_msg TEXT,
      priority INTEGER DEFAULT 0,
      client_spoofing TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS model_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requested_model TEXT NOT NULL,
      provider TEXT NOT NULL,
      upstream_model TEXT NOT NULL,
      group_id INTEGER NOT NULL,
      enabled INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash TEXT NOT NULL UNIQUE,
      name TEXT,
      enabled INTEGER DEFAULT 1,
      balance REAL DEFAULT 0,
      quota_limit REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS usage_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id INTEGER,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      status INTEGER DEFAULT 200,
      error_message TEXT,
      latency_ms INTEGER,
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      channel_id INTEGER NOT NULL,
      group_id INTEGER NOT NULL,
      model TEXT NOT NULL,
      status INTEGER NOT NULL,
      error_message TEXT,
      latency_ms INTEGER,
      created_at TEXT DEFAULT (datetime('now')));

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')));

    -- users too: a previous suite may have left an administrator with different
    -- credentials, and setup refuses to claim an existing one.
    DELETE FROM accounts; DELETE FROM channels; DELETE FROM groups; DELETE FROM users;
    -- Both flags must go. Leaving schema_version behind makes ensureSchema take
    -- its fast path and skip the fold entirely, so the seeded database would
    -- never actually be migrated and the suite would test nothing.
    DELETE FROM settings WHERE key IN ('channels_folded_into_accounts', 'schema_version');

    INSERT INTO groups (id, name, priority) VALUES (1, 'legacy-group', 0);

    -- Channel 1: holds the shared credential and a discounted multiplier.
    INSERT INTO channels (id, name, provider, base_url, api_key, enabled, priority, rate_multiplier)
      VALUES (1, 'legacy-shared', 'openai', 'https://shared.example.com', 'sk-CHANNEL-SHARED', 1, 0, 0.25);
    -- Channel 2: disabled, so its accounts were being skipped by scheduling.
    INSERT INTO channels (id, name, provider, base_url, api_key, enabled, priority, rate_multiplier)
      VALUES (2, 'legacy-disabled', 'openai', 'https://off.example.com', 'sk-CHANNEL-OFF', 0, 0, 1);

    -- Blank key + blank base_url: entirely dependent on channel inheritance.
    INSERT INTO accounts (id, name, provider, api_key, base_url, group_id, channel_id, enabled)
      VALUES (1, 'inheriting', 'openai', '', '', 1, 1, 1);
    -- Own credentials: must NOT be overwritten by the channel's.
    INSERT INTO accounts (id, name, provider, api_key, base_url, group_id, channel_id, enabled)
      VALUES (2, 'self-sufficient', 'openai', 'sk-ACCOUNT-OWN', 'https://own.example.com', 1, 1, 1);
    -- Enabled account under a DISABLED channel: was unschedulable before.
    INSERT INTO accounts (id, name, provider, api_key, base_url, group_id, channel_id, enabled)
      VALUES (3, 'under-disabled-channel', 'openai', 'sk-ACCOUNT-C3', '', 1, 2, 1);
    """)
    connection.commit()
    connection.close()


def read_accounts(db_path):
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    rows = connection.execute(
        'SELECT id, name, api_key, base_url, enabled, rate_multiplier FROM accounts ORDER BY id'
    ).fetchall()
    connection.close()
    return {row['name']: dict(row) for row in rows}


if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit('usage: python tests/migration.test.py <d1-sqlite-path>')
    db_file = sys.argv[1]
    mode = os.environ.get('MIGRATION_PHASE', 'seed')

    if mode == 'seed':
        seed_old_shape(db_file)
        print('seeded old-shape database with channels')
        raise SystemExit(0)

    # Phase 2: the worker has started and run ensureSchema against the file.
    # Touch an authenticated endpoint so the migration definitely executed.
    call('/auth/setup', 'POST', {'username': ADMIN[0], 'password': ADMIN[1]})
    status, payload = call('/auth/login', 'POST', {'username': ADMIN[0], 'password': ADMIN[1]})
    token = payload.get('token')
    check('legacy admin can still log in', bool(token), (status, payload))

    status, listing = call('/accounts', token=token)
    check('accounts still listable after fold', status == 200, (status, listing))
    names = {row.get('name') for row in listing.get('data', [])}
    check('no account was lost', {'inheriting', 'self-sufficient', 'under-disabled-channel'} <= names, names)

    accounts = read_accounts(db_file)

    inheriting = accounts.get('inheriting', {})
    check('inherited channel key was written onto the account',
          inheriting.get('api_key') == 'sk-CHANNEL-SHARED', inheriting.get('api_key'))
    check('inherited base_url was written onto the account',
          inheriting.get('base_url') == 'https://shared.example.com', inheriting.get('base_url'))
    check('inherited channel multiplier carried across',
          float(inheriting.get('rate_multiplier') or 1) == 0.25, inheriting.get('rate_multiplier'))

    own = accounts.get('self-sufficient', {})
    check('account credential was not overwritten',
          own.get('api_key') == 'sk-ACCOUNT-OWN', own.get('api_key'))
    check('account base_url was not overwritten',
          own.get('base_url') == 'https://own.example.com', own.get('base_url'))

    masked = accounts.get('under-disabled-channel', {})
    check('account under a disabled channel was disabled, not silently activated',
          int(masked.get('enabled') or 0) == 0, masked.get('enabled'))
    check('that account kept its own key',
          masked.get('api_key') == 'sk-ACCOUNT-C3', masked.get('api_key'))

    # Re-running must be a no-op rather than re-applying the fold.
    status, _ = call('/accounts', token=token)
    again = read_accounts(db_file)
    check('migration is idempotent', again == accounts, 'second pass changed rows')

    print()
    print(f'PASSED {passed} / {passed + len(failures)}')
    for failure in failures:
        print(' -', failure)
    raise SystemExit(1 if failures else 0)
