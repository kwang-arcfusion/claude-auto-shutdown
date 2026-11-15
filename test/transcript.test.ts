import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { rmSync } from 'node:fs';
import {
  analyzeTranscriptLines,
  classifyTranscriptLines,
  projectSlug,
  readTranscriptState,
  TranscriptInfoCache,
} from '../src/main/detector/transcript';

const line = (entry: object): string => JSON.stringify(entry);
const user = (content: unknown, extra: object = {}): string => line({ type: 'user', message: { role: 'user', content }, ...extra });
const assistant = (stop: string | null, blocks: object[] = [{ type: 'text', text: 'x' }]): string =>
  line({ type: 'assistant', message: { role: 'assistant', stop_reason: stop, content: blocks } });
const meta = (type: string): string => line({ type });
const stopHooks = line({ type: 'system', subtype: 'stop_hook_summary' });

test('a finished turn ends with end_turn and stop_hook_summary', () => {
  assert.equal(classifyTranscriptLines([user('hi'), assistant('end_turn'), stopHooks, meta('custom-title'), meta('atis-latch')]), 'ended');
});

test('end_turn without the hook summary also counts as finished', () => {
  assert.equal(classifyTranscriptLines([user('hi'), assistant('end_turn')]), 'ended');
});

test('a tool call in progress is running', () => {
  assert.equal(classifyTranscriptLines([user('hi'), assistant('tool_use', [{ type: 'tool_use', name: 'Bash' }])]), 'running');
});

test('a tool result waiting for the model is running', () => {
  assert.equal(classifyTranscriptLines([assistant('tool_use'), user([{ type: 'tool_result', content: 'ok' }]), meta('agent-name')]), 'running');
});

test('an api-request entry after a finished turn means a new model call is in flight', () => {
  assert.equal(classifyTranscriptLines([assistant('end_turn'), stopHooks, meta('api-request')]), 'running');
});

test('an interrupted turn counts as finished', () => {
  assert.equal(
    classifyTranscriptLines([assistant('tool_use'), user([{ type: 'text', text: '[Request interrupted by user for tool use]' }])]),
    'ended',
  );
});

test('meta user entries are skipped', () => {
  assert.equal(classifyTranscriptLines([assistant('end_turn'), user('<local-command-caveat>', { isMeta: true })]), 'ended');
});

test('only metadata or broken lines give unknown', () => {
  assert.equal(classifyTranscriptLines([meta('custom-title'), '{"type":"assis', '']), 'unknown');
});

test('readTranscriptState widens the window when the last line is huge', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cas-transcript-'));
  const file = path.join(dir, 'session.jsonl');
  const hugeToolResult = user([{ type: 'tool_result', content: 'x'.repeat(300_000) }]);
  writeFileSync(file, `${[assistant('tool_use'), hugeToolResult].join('\n')}\n`);
  assert.equal(await readTranscriptState(file, statSync(file).size), 'running');
});

// ---- pending tool calls and scheduled wake-ups ------------------------------------------

const T0 = Date.parse('2026-11-16T01:00:00.000Z');
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const toolUse = (id: string, name: string, minute: number, input: object = {}): string =>
  line({ type: 'assistant', timestamp: at(minute), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id: string, minute: number): string =>
  line({ type: 'user', timestamp: at(minute), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const endTurn = (minute: number): string =>
  line({ type: 'assistant', timestamp: at(minute), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } });

test('analyzeTranscriptLines lists tool calls that have no result yet, with their time', () => {
  const info = analyzeTranscriptLines([toolUse('a', 'Read', 0), toolResult('a', 0), toolUse('b', 'Bash', 1), toolUse('c', 'Edit', 1), toolResult('c', 2)]);
  assert.equal(info.state, 'running');
  assert.deepEqual(info.pendingTools, [{ id: 'b', name: 'Bash', at: T0 + 60_000 }]);
});

test('a finished or interrupted turn clears its pending calls', () => {
  assert.deepEqual(analyzeTranscriptLines([toolUse('a', 'Bash', 0), endTurn(1)]).pendingTools, []);
  const interrupted = user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]);
  assert.deepEqual(analyzeTranscriptLines([toolUse('a', 'Bash', 0), interrupted]).pendingTools, []);
});

test('ScheduleWakeup sets the wake-up time; stop: true cancels it', () => {
  const scheduled = analyzeTranscriptLines([toolUse('w', 'ScheduleWakeup', 10, { delaySeconds: 1200 }), toolResult('w', 10), endTurn(10), stopHooks]);
  assert.equal(scheduled.state, 'ended');
  assert.equal(scheduled.scheduledWakeAt, T0 + 10 * 60_000 + 1_200_000);
  assert.deepEqual(scheduled.pendingTools, []);

  const clamped = analyzeTranscriptLines([toolUse('w', 'ScheduleWakeup', 0, { delaySeconds: 99_999 })]);
  assert.equal(clamped.scheduledWakeAt, T0 + 3_600_000); // the tool allows at most an hour

  const stopped = analyzeTranscriptLines([
    toolUse('w1', 'ScheduleWakeup', 0, { delaySeconds: 600 }),
    toolResult('w1', 0),
    toolUse('w2', 'ScheduleWakeup', 10, { stop: true }),
    toolResult('w2', 10),
  ]);
  assert.equal(stopped.scheduledWakeAt, null);
});

test('TranscriptInfoCache evicts only the least recently used entry when full', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cas-cache-'));
  const files = ['a', 'b', 'c'].map((name) => {
    const file = path.join(dir, `${name}.jsonl`);
    writeFileSync(file, `${assistant('end_turn')}\n`);
    return file;
  });
  const [a, b, c] = files as [string, string, string];
  const size = statSync(a).size;
  const cache = new TranscriptInfoCache(2);
  await cache.get(a, 1, size);
  await cache.get(b, 1, size);
  await cache.get(a, 1, size); // a is now the most recent
  await cache.get(c, 1, size); // evicts b, keeps a
  assert.equal(cache.size, 2);
  rmSync(a);
  rmSync(b);
  assert.equal((await cache.get(a, 1, size)).state, 'ended'); // served from the cache
  await assert.rejects(cache.get(b, 1, size)); // evicted, so it has to read the (deleted) file
});

test('projectSlug matches Claude Code project folder names', () => {
  assert.equal(projectSlug('C:\\Users\\me\\Desktop\\my-app'), 'C--Users-me-Desktop-my-app');
});
