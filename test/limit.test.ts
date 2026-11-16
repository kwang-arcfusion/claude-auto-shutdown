// A usage limit ends the turn with an API error; subagents cut off by it stay mid-turn; a session
// forked from another writes its subagents under the original session's folder. Seen on this PC
// with Claude Code 2.1.325 (the limit hit at 04:47, the app showed "Background" for 20 minutes).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ClaudeDetector } from '../src/main/detector/claude';
import type { ProcInfo } from '../src/main/detector/processes';
import { evaluateSession, type EvaluateInput, type ProcessFacts, type SessionFile } from '../src/main/detector/session';
import { analyzeTranscriptLines } from '../src/main/detector/transcript';
import { render } from '../src/shared/i18n';
import { DEFAULT_SETTINGS } from '../src/shared/settings';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const line = (entry: object): string => JSON.stringify(entry);
const limitError = line({
  type: 'assistant',
  isApiErrorMessage: true,
  error: 'rate_limit',
  apiErrorStatus: 429,
  message: { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 6:20am (Asia/Bangkok)" }] },
});
const prompt = line({ type: 'user', message: { role: 'user', content: 'continue' } });
const reply = line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } });

const facts = (overrides: Partial<ProcessFacts> = {}): ProcessFacts => ({ tools: [], helperCpuPercent: 0, toolsActiveAt: null, ...overrides });
function input(file: Partial<SessionFile>, overrides: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    file: { pid: 1, sessionId: 's', status: 'idle', statusUpdatedAt: NOW - MIN, ...file },
    transcriptState: 'ended',
    lastActivityAt: NOW - MIN,
    sideActivityAt: null,
    pendingTools: [],
    scheduledWakeAt: null,
    runningSubagentAt: null,
    processes: facts(),
    now: NOW,
    settings: { ...DEFAULT_SETTINGS },
    ...overrides,
  };
}

test('a turn that ends with an API error is recorded; a later prompt or reply clears it', () => {
  assert.equal(analyzeTranscriptLines([prompt, limitError]).endedWithError, "You've hit your 5-hour limit · resets 6:20am (Asia/Bangkok)");
  assert.equal(analyzeTranscriptLines([prompt, limitError, line({ type: 'last-prompt' })]).endedWithError?.startsWith("You've hit"), true);
  assert.equal(analyzeTranscriptLines([prompt, limitError, prompt]).endedWithError, null);
  assert.equal(analyzeTranscriptLines([prompt, limitError, prompt, reply]).endedWithError, null);
  assert.equal(analyzeTranscriptLines([prompt, reply]).endedWithError, null);
});

test('stopped by an API error: finished at once, whatever helpers or subagent leftovers show', () => {
  const stopped = evaluateSession(
    input({}, { stoppedByError: "You've hit your 5-hour limit", runningSubagentAt: NOW - 2 * MIN, processes: facts({ helperCpuPercent: 40 }) }),
  );
  assert.equal(stopped.verdict, 'stopped');
  assert.equal(stopped.blocksShutdown, false);
  assert.equal(render('en', stopped.reason), "Stopped by an error: You've hit your 5-hour limit");
  assert.equal(render('th', stopped.reason), "หยุดเพราะเกิดข้อผิดพลาด: You've hit your 5-hour limit");

  // A command still running keeps the PC on, and a /loop wake-up still counts.
  const running = facts({ tools: [{ pid: 9, ppid: 1, name: 'bash.exe', created: 1, cpuTicks: 0, ioBytes: 0, cmd: '' } as ProcInfo], toolsActiveAt: NOW });
  assert.equal(evaluateSession(input({}, { stoppedByError: 'limit', processes: running })).verdict, 'tool');
  assert.equal(evaluateSession(input({}, { stoppedByError: 'limit', scheduledWakeAt: NOW + 10 * MIN })).verdict, 'scheduled');
});

test('a version that reports its own state: a subagent left mid-turn after going idle is a leftover', () => {
  const leftover = { runningSubagentAt: NOW - 5 * MIN };
  assert.equal(evaluateSession(input({ version: '2.1.325' }, leftover)).verdict, 'idle');
  assert.equal(evaluateSession(input({ version: '2.2.0' }, leftover)).verdict, 'idle');
  // Older versions do not report background agents in their status: still trusted.
  assert.equal(evaluateSession(input({}, leftover)).verdict, 'background');
  assert.equal(evaluateSession(input({ version: '2.1.300' }, leftover)).verdict, 'background');
});

test('a forked session writing its subagents under the original session folder is not called silent', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cas-fork-'));
  const project = path.join(dir, 'projects', 'C--work-app');
  mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  mkdirSync(path.join(project, 'original', 'subagents'), { recursive: true });
  const now = Date.now();
  writeFileSync(
    path.join(dir, 'sessions', '11.json'),
    JSON.stringify({ pid: 11, sessionId: 'fork', cwd: 'C:\\work\\app', procStart: '5000', status: 'busy', statusUpdatedAt: now - 3 * 60 * MIN }),
  );
  // The fork's own transcript has been quiet for an hour (waiting on its agent)...
  const own = path.join(project, 'fork.jsonl');
  writeFileSync(own, `${line({ type: 'assistant', message: { stop_reason: 'tool_use', content: [] } })}\n`);
  utimesSync(own, (now - 60 * MIN) / 1000, (now - 60 * MIN) / 1000);
  // ...while the agent writes under the session it was forked from.
  const agent = path.join(project, 'original', 'subagents', 'agent-a1.jsonl');
  writeFileSync(agent, `${line({ type: 'assistant', message: { stop_reason: 'tool_use', content: [] } })}\n`);

  const proc: ProcInfo = { pid: 11, ppid: 1, name: 'claude.exe', created: 5000, cpuTicks: 0, ioBytes: 0, cmd: 'claude.exe' };
  const detector = new ClaudeDetector({
    claudeDir: () => dir,
    snapshotter: { take: async () => ({ at: Date.now(), procs: [proc] }) },
    tempRoot: mkdtempSync(path.join(os.tmpdir(), 'cas-tmp-')),
    isPidAlive: (pid) => pid === 11,
    sleep: async () => {},
  });
  const working = await detector.detect({ ...DEFAULT_SETTINGS });
  assert.equal(working.sessions[0]!.verdict, 'working');
  assert.equal(working.aggregate, 'busy');

  // Once nothing in the project folder moves either, the silence rule applies as before.
  utimesSync(agent, (now - 60 * MIN) / 1000, (now - 60 * MIN) / 1000);
  const quiet = await detector.detect({ ...DEFAULT_SETTINGS });
  assert.equal(quiet.sessions[0]!.verdict, 'stalled');
});
