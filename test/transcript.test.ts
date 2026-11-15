import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { classifyTranscriptLines, projectSlug, readTranscriptState } from '../src/main/detector/transcript';

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

test('projectSlug matches Claude Code project folder names', () => {
  assert.equal(projectSlug('C:\\Users\\me\\Desktop\\my-app'), 'C--Users-me-Desktop-my-app');
});
