import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LogStore } from '../src/main/log-store';

const DAY = 24 * 60 * 60 * 1000;
const tempDb = (): string => path.join(mkdtempSync(path.join(os.tmpdir(), 'cas-logs-')), 'logs.sqlite');

test('entries survive reopening and come back oldest first', () => {
  const file = tempDb();
  const now = 1_800_000_000_000;
  const first = new LogStore(file, 30, () => now);
  first.append({ at: now - 2_000, level: 'info', message: 'one' });
  first.append({ at: now - 1_000, level: 'warn', message: 'two' });
  first.close();

  const second = new LogStore(file, 30, () => now);
  assert.deepEqual(
    second.recent(10).map((e) => e.message),
    ['one', 'two'],
  );
  assert.equal(second.recent(1)[0]!.message, 'two');
  assert.equal(second.recent(10)[1]!.level, 'warn');
  second.close();
});

test('entries older than 30 days are deleted by prune() and when the store opens', () => {
  const file = tempDb();
  let now = 1_800_000_000_000;
  const store = new LogStore(file, 30, () => now);
  store.append({ at: now - 31 * DAY, level: 'info', message: 'old' });
  store.append({ at: now - 29 * DAY, level: 'info', message: 'recent' });
  assert.equal(store.prune(), 1);
  assert.deepEqual(
    store.recent(10).map((e) => e.message),
    ['recent'],
  );

  now += 2 * DAY; // "recent" is now 31 days old
  assert.equal(store.prune(), 1);
  assert.equal(store.count(), 0);

  store.append({ at: now - 40 * DAY, level: 'info', message: 'stale' });
  store.append({ at: now, level: 'info', message: 'fresh' });
  store.close();
  const reopened = new LogStore(file, 30, () => now);
  assert.deepEqual(
    reopened.recent(10).map((e) => e.message),
    ['fresh'],
  );
  reopened.close();
});
