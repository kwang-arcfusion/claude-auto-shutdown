import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProcInfo } from '../src/main/detector/processes';
import { evaluateSession, parseSessionFile, type EvaluateInput, type SessionFile } from '../src/main/detector/session';
import { DEFAULT_SETTINGS } from '../src/shared/settings';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const proc = (name: string): ProcInfo => ({ pid: 10, ppid: 1, name, created: 1, cpuTicks: 0, cmd: '' });

function input(file: Partial<SessionFile>, overrides: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    file: { pid: 1, sessionId: 's', ...file },
    transcriptState: 'unknown',
    lastActivityAt: NOW - MIN,
    sideActivityAt: null,
    processes: { tools: [], helperCpuPercent: 0 },
    now: NOW,
    settings: { ...DEFAULT_SETTINGS },
    ...overrides,
  };
}

test('parseSessionFile reads the fields Claude Code writes', () => {
  const file = parseSessionFile(
    JSON.stringify({
      pid: 28348,
      sessionId: 'd443719b',
      cwd: 'C:\\work',
      procStart: '134391962772404597',
      status: 'busy',
      statusUpdatedAt: 5,
      updatedAt: 6,
      entrypoint: 'claude-desktop',
      waitingFor: 'permission',
    }),
  );
  assert.ok(file);
  assert.equal(file.pid, 28348);
  assert.equal(file.status, 'busy');
  assert.equal(file.procStart, '134391962772404597');
  assert.equal(file.waitingFor, 'permission');
  assert.equal(file.statusUpdatedAt, 5);
});

test('parseSessionFile rejects junk', () => {
  assert.equal(parseSessionFile('not json'), null);
  assert.equal(parseSessionFile('{"pid":"x","sessionId":"a"}'), null);
  assert.equal(parseSessionFile('{"pid":5}'), null);
  assert.equal(parseSessionFile('null'), null);
});

test('idle status with nothing running is idle', () => {
  const r = evaluateSession(input({ status: 'idle' }));
  assert.equal(r.verdict, 'idle');
  assert.equal(r.blocksShutdown, false);
});

test('busy status keeps the machine on', () => {
  const r = evaluateSession(input({ status: 'busy' }));
  assert.equal(r.verdict, 'working');
  assert.equal(r.blocksShutdown, true);
});

test('a running tool shell blocks even when the status is idle (background task)', () => {
  const r = evaluateSession(input({ status: 'idle' }, { processes: { tools: [proc('bash.exe')], helperCpuPercent: 0 } }));
  assert.equal(r.verdict, 'tool');
  assert.equal(r.blocksShutdown, true);
  assert.match(r.reason, /bash\.exe/);
});

test('busy but silent past the stall limit counts as finished once processes are checked', () => {
  const r = evaluateSession(input({ status: 'busy' }, { lastActivityAt: NOW - 50 * MIN }));
  assert.equal(r.verdict, 'stalled');
  assert.equal(r.blocksShutdown, false);
});

test('a stall candidate without a process check asks for one and keeps blocking', () => {
  const r = evaluateSession(input({ status: 'busy' }, { lastActivityAt: NOW - 50 * MIN, processes: null }));
  assert.equal(r.blocksShutdown, true);
  assert.equal(r.needsProcessCheck, true);
});

test('stalledMinutes = 0 never treats a busy session as finished', () => {
  const r = evaluateSession(
    input({ status: 'busy' }, { lastActivityAt: NOW - 600 * MIN, settings: { ...DEFAULT_SETTINGS, stalledMinutes: 0 } }),
  );
  assert.equal(r.verdict, 'working');
  assert.equal(r.blocksShutdown, true);
});

test('a long-running tool is never treated as stalled', () => {
  const r = evaluateSession(
    input({ status: 'busy' }, { lastActivityAt: NOW - 120 * MIN, processes: { tools: [proc('node.exe')], helperCpuPercent: 0 } }),
  );
  assert.equal(r.verdict, 'tool');
  assert.equal(r.blocksShutdown, true);
});

test('busy helper processes stop a silent busy session from counting as stalled', () => {
  const r = evaluateSession(input({ status: 'busy' }, { lastActivityAt: NOW - 50 * MIN, processes: { tools: [], helperCpuPercent: 30 } }));
  assert.equal(r.blocksShutdown, true);
});

test('waiting on the user blocks until the stall limit', () => {
  const recent = evaluateSession(input({ status: 'busy', waitingFor: 'permission' }));
  assert.equal(recent.verdict, 'waiting');
  assert.equal(recent.blocksShutdown, true);
  const old = evaluateSession(input({ status: 'idle', waitingFor: 'permission' }, { lastActivityAt: NOW - 46 * MIN }));
  assert.equal(old.verdict, 'stalled');
  assert.equal(old.blocksShutdown, false);
});

test('recent subagent writes keep an idle session busy', () => {
  const recent = evaluateSession(input({ status: 'idle' }, { sideActivityAt: NOW - 30_000 }));
  assert.equal(recent.verdict, 'background');
  assert.equal(recent.blocksShutdown, true);
  const old = evaluateSession(input({ status: 'idle' }, { sideActivityAt: NOW - 5 * MIN }));
  assert.equal(old.verdict, 'idle');
});

test('helper CPU above the threshold keeps an idle session busy', () => {
  const r = evaluateSession(input({ status: 'idle' }, { processes: { tools: [], helperCpuPercent: 12 } }));
  assert.equal(r.verdict, 'background');
  assert.equal(r.blocksShutdown, true);
});

test('without a status field the transcript decides, and unknown counts as busy', () => {
  assert.equal(evaluateSession(input({}, { transcriptState: 'running' })).blocksShutdown, true);
  assert.equal(evaluateSession(input({}, { transcriptState: 'ended' })).blocksShutdown, false);
  assert.equal(evaluateSession(input({}, { transcriptState: 'unknown' })).blocksShutdown, true);
});
