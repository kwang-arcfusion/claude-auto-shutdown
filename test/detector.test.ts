import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ClaudeDetector } from '../src/main/detector/claude';
import type { ProcInfo, ProcessSnapshot } from '../src/main/detector/processes';
import { msToFiletime } from '../src/main/detector/tree';
import { DEFAULT_SETTINGS } from '../src/shared/settings';
import type { DetectionResult } from '../src/shared/types';

const BASH_TOOL =
  '"C:\\Program Files\\Git\\bin\\bash.exe" -c "source /c/Users/me/.claude/shell-snapshots/snapshot-bash-1.sh && eval \'npm test\'"';
const MCP_SERVER = 'C:\\Users\\me\\.pencil\\mcp\\out\\mcp-server-windows-x64.exe';
const MIN = 60_000;
const HOUR = 60 * MIN;
const START = 1_800_000_000_000;
const settings = { ...DEFAULT_SETTINGS };

interface FakeSession {
  pid: number;
  sessionId: string;
  status?: string;
  procStart?: string;
  cwd?: string;
  statusUpdatedAt?: number;
}

const tempDir = (prefix: string): string => mkdtempSync(path.join(os.tmpdir(), prefix));

function claudeDir(sessions: FakeSession[], transcripts: Record<string, string[]> = {}): string {
  const dir = tempDir('cas-claude-');
  mkdirSync(path.join(dir, 'sessions'));
  for (const s of sessions) writeFileSync(path.join(dir, 'sessions', `${s.pid}.json`), JSON.stringify(s));
  writeFileSync(path.join(dir, 'sessions', '11.0123abcd.key'), 'not a session file');
  for (const [sessionId, lines] of Object.entries(transcripts)) {
    const project = path.join(dir, 'projects', 'C--work-app');
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, `${sessionId}.jsonl`), `${lines.join('\n')}\n`);
  }
  return dir;
}

class FakeSnapshotter {
  calls = 0;
  constructor(private readonly procs: () => ProcInfo[]) {}
  async take(): Promise<ProcessSnapshot> {
    this.calls++;
    return { at: 1_000_000 + this.calls * 2_000, procs: this.procs() };
  }
}

const claudeProc = (pid: number, created = 5_000): ProcInfo => ({
  pid,
  ppid: 1,
  name: 'claude.exe',
  created,
  cpuTicks: 0,
  ioBytes: 0,
  cmd: 'claude.exe --output-format stream-json',
});
const child = (pid: number, ppid: number, name: string, cmd: string, created = 6_000): ProcInfo => ({
  pid,
  ppid,
  name,
  created,
  cpuTicks: 0,
  ioBytes: 0,
  cmd,
});

function detector(dir: string, snapshotter: { take(): Promise<ProcessSnapshot> }, alive: number[]): ClaudeDetector {
  return new ClaudeDetector({
    claudeDir: () => dir,
    snapshotter,
    tempRoot: tempDir('cas-tmp-'),
    isPidAlive: (pid) => alive.includes(pid),
    sleep: async () => {},
  });
}

/** A detector on a simulated clock; the fake 2 s sleep between snapshots moves the clock too. */
function clocked(dir: string, procs: () => ProcInfo[], alive: number[], tempRoot = tempDir('cas-tmp-')) {
  const state = { clock: START };
  const d = new ClaudeDetector({
    claudeDir: () => dir,
    snapshotter: { take: async () => ({ at: state.clock, procs: procs() }) },
    tempRoot,
    now: () => state.clock,
    isPidAlive: (pid) => alive.includes(pid),
    sleep: async (ms) => {
      state.clock += ms;
    },
  });
  /** Polls every 30 s for `minutes`, returning the last result. */
  const pollFor = async (minutes: number): Promise<DetectionResult> => {
    let r = await d.detect(settings);
    for (let i = 1; i < minutes * 2; i++) {
      state.clock += 30_000;
      r = await d.detect(settings);
    }
    return r;
  };
  return { state, d, pollFor };
}

// ---- basics ------------------------------------------------------------------------------

test('one busy session is enough: no process snapshot is taken', async () => {
  const now = Date.now();
  const dir = claudeDir([
    { pid: 11, sessionId: 'a', status: 'busy', procStart: '5000', statusUpdatedAt: now },
    { pid: 12, sessionId: 'b', status: 'idle', procStart: '5000', statusUpdatedAt: now },
  ]);
  const snap = new FakeSnapshotter(() => [claudeProc(11), claudeProc(12)]);
  const r = await detector(dir, snap, [11, 12]).detect(settings);
  assert.equal(r.aggregate, 'busy');
  assert.equal(r.usedProcessSnapshot, false);
  assert.equal(snap.calls, 0);
  assert.equal(r.sessions.length, 2);
  assert.equal(r.sessions[0]!.pid, 11); // blocking sessions first
});

test('all idle: processes are checked, with a second snapshot only for the first baseline', async () => {
  const dir = claudeDir([{ pid: 11, sessionId: 'a', status: 'idle', procStart: '5000', statusUpdatedAt: Date.now() }]);
  const snap = new FakeSnapshotter(() => [claudeProc(11), child(20, 11, 'mcp-server-windows-x64.exe', MCP_SERVER)]);
  const d = detector(dir, snap, [11]);
  const first = await d.detect(settings);
  assert.equal(first.aggregate, 'idle');
  assert.equal(first.usedProcessSnapshot, true);
  assert.equal(snap.calls, 2);
  assert.equal(first.sessions[0]!.helperCpuPercent, 0);
  await d.detect(settings);
  assert.equal(snap.calls, 3);
});

test('an idle session with a background tool shell keeps the machine on', async () => {
  const dir = claudeDir([{ pid: 11, sessionId: 'a', status: 'idle', procStart: '5000', statusUpdatedAt: Date.now() }]);
  const snap = new FakeSnapshotter(() => [claudeProc(11), child(21, 11, 'bash.exe', BASH_TOOL), child(22, 21, 'node.exe', 'node test.js')]);
  const r = await detector(dir, snap, [11]).detect(settings);
  assert.equal(r.aggregate, 'busy');
  assert.equal(r.sessions[0]!.verdict, 'tool');
  assert.deepEqual(r.sessions[0]!.toolProcesses, ['bash.exe', 'node.exe']);
});

test('session files left by exited or replaced processes are ignored', async () => {
  const dir = claudeDir([
    { pid: 11, sessionId: 'dead', status: 'busy', procStart: '5000', statusUpdatedAt: Date.now() },
    // Busy but silent for 3 hours, and PID 12 now belongs to a process created much later.
    { pid: 12, sessionId: 'reused', status: 'busy', procStart: '5000', statusUpdatedAt: Date.now() - 3 * HOUR },
  ]);
  const snap = new FakeSnapshotter(() => [claudeProc(12, 99_000_000_000)]);
  const r = await detector(dir, snap, [12]).detect(settings);
  assert.equal(r.aggregate, 'idle');
  assert.equal(r.sessions.length, 0);
});

test('a missing sessions folder gives unknown', async () => {
  const r = await detector(path.join(os.tmpdir(), 'cas-does-not-exist-123'), new FakeSnapshotter(() => []), []).detect(settings);
  assert.equal(r.aggregate, 'unknown');
  assert.match(r.error ?? '', /ไม่พบโฟลเดอร์/);
});

test('a failing process snapshot gives unknown, never idle', async () => {
  const dir = claudeDir([{ pid: 11, sessionId: 'a', status: 'idle', procStart: '5000', statusUpdatedAt: Date.now() }]);
  const failing = {
    take: async (): Promise<ProcessSnapshot> => {
      throw new Error('powershell timed out');
    },
  };
  const r = await detector(dir, failing, [11]).detect(settings);
  assert.equal(r.aggregate, 'unknown');
  assert.match(r.error ?? '', /timed out/);
});

test('an unreadable session file for a live process gives unknown', async () => {
  const dir = claudeDir([]);
  writeFileSync(path.join(dir, 'sessions', '13.json'), '{"pid":13,"sessionId":');
  const r = await detector(dir, new FakeSnapshotter(() => []), [13]).detect(settings);
  assert.equal(r.aggregate, 'unknown');
});

test('without a status field the transcript decides', async () => {
  const running = JSON.stringify({ type: 'assistant', message: { stop_reason: 'tool_use', content: [] } });
  const ended = JSON.stringify({ type: 'system', subtype: 'stop_hook_summary' });
  const dirRunning = claudeDir([{ pid: 11, sessionId: 'c', procStart: '5000', cwd: 'C:\\work\\app' }], { c: [running] });
  const busy = await detector(dirRunning, new FakeSnapshotter(() => [claudeProc(11)]), [11]).detect(settings);
  assert.equal(busy.aggregate, 'busy');
  assert.equal(busy.sessions[0]!.transcriptState, 'running');

  const dirEnded = claudeDir([{ pid: 11, sessionId: 'c', procStart: '5000', cwd: 'C:\\work\\app' }], { c: [running, ended] });
  const idle = await detector(dirEnded, new FakeSnapshotter(() => [claudeProc(11)]), [11]).detect(settings);
  assert.equal(idle.aggregate, 'idle');
});

// ---- hung, quiet and sleeping background commands -----------------------------------------

test('a background command with no activity for 20 minutes counts as hung; CPU use wakes it up', async () => {
  const dir = claudeDir([{ pid: 11, sessionId: 'a', status: 'idle', procStart: '5000', statusUpdatedAt: START }]);
  let cpu = 0;
  const { state, d, pollFor } = clocked(dir, () => [claudeProc(11), { ...child(21, 11, 'bash.exe', BASH_TOOL), cpuTicks: cpu }], [11]);
  assert.equal((await pollFor(19)).sessions[0]!.verdict, 'tool');
  const hung = await pollFor(2);
  assert.equal(hung.sessions[0]!.verdict, 'stalled');
  assert.equal(hung.aggregate, 'idle');

  cpu += 10_000_000; // 1 s of CPU within the next 30 s = 3.3 %
  state.clock += 30_000;
  assert.equal((await d.detect(settings)).sessions[0]!.verdict, 'tool');
});

test('output written by a background task counts as activity', async () => {
  const dir = claudeDir([{ pid: 11, sessionId: 'a', status: 'idle', procStart: '5000', statusUpdatedAt: START }]);
  const temp = tempDir('cas-tmp-');
  const tasks = path.join(temp, '75999069b0a08cfc', 'a', 'tasks');
  mkdirSync(tasks, { recursive: true });
  const output = path.join(tasks, 'b1.output');
  writeFileSync(output, 'starting\n');
  utimesSync(output, new Date(START), new Date(START));
  const { state, d, pollFor } = clocked(dir, () => [claudeProc(11), child(21, 11, 'bash.exe', BASH_TOOL)], [11], temp);
  assert.equal((await pollFor(21)).sessions[0]!.verdict, 'stalled');

  appendFileSync(output, 'still going\n');
  state.clock += 30_000;
  utimesSync(output, new Date(state.clock), new Date(state.clock));
  assert.equal((await d.detect(settings)).sessions[0]!.verdict, 'tool');
});

test('a timed sleep keeps waiting until it should end, then counts as hung after 20 quiet minutes', async () => {
  const dir = claudeDir([{ pid: 11, sessionId: 'a', status: 'idle', procStart: '5000', statusUpdatedAt: START }]);
  const procs = (): ProcInfo[] => [
    claudeProc(11),
    child(21, 11, 'bash.exe', BASH_TOOL),
    child(22, 21, 'sleep.exe', 'C:\\Program Files\\Git\\usr\\bin\\sleep.exe 3600', msToFiletime(START)),
  ];
  const { pollFor } = clocked(dir, procs, [11]);
  assert.equal((await pollFor(59)).sessions[0]!.verdict, 'tool');
  assert.equal((await pollFor(21)).sessions[0]!.verdict, 'tool'); // sleep ended ~61 min, quiet < 20 min
  assert.equal((await pollFor(3)).sessions[0]!.verdict, 'stalled');
});

// ---- waiting for the user, subagents, scheduled wake-ups ----------------------------------

test('an unanswered Bash call with no shell is a permission prompt: waits 5 minutes, then counts as finished', async () => {
  const prompt = JSON.stringify({ type: 'user', timestamp: new Date(START).toISOString(), message: { role: 'user', content: 'go' } });
  const bash = JSON.stringify({
    type: 'assistant',
    timestamp: new Date(START).toISOString(),
    message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm publish' } }] },
  });
  const dir = claudeDir([{ pid: 11, sessionId: 'p', status: 'busy', procStart: '5000', cwd: 'C:\\work\\app', statusUpdatedAt: START }], {
    p: [prompt, bash],
  });
  const { state, d } = clocked(dir, () => [claudeProc(11)], [11]);

  state.clock = START + 30_000; // the shell may still be starting
  assert.equal((await d.detect(settings)).sessions[0]!.verdict, 'working');
  state.clock = START + 2 * MIN;
  const waiting = await d.detect(settings);
  assert.equal(waiting.sessions[0]!.verdict, 'waiting');
  assert.equal(waiting.aggregate, 'busy');
  state.clock = START + 6 * MIN;
  const late = await d.detect(settings);
  assert.equal(late.sessions[0]!.verdict, 'stalled');
  assert.equal(late.aggregate, 'idle');
});

test('a subagent still mid-turn keeps an idle session busy', async () => {
  const done = JSON.stringify({ type: 'system', subtype: 'stop_hook_summary' });
  const dir = claudeDir([{ pid: 11, sessionId: 's', status: 'idle', procStart: '5000', cwd: 'C:\\work\\app', statusUpdatedAt: START }], { s: [done] });
  const subagents = path.join(dir, 'projects', 'C--work-app', 's', 'subagents');
  mkdirSync(subagents, { recursive: true });
  const agent = path.join(subagents, 'agent-a1.jsonl');
  writeFileSync(agent, `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } })}\n`);
  utimesSync(agent, new Date(START - 10 * MIN), new Date(START - 10 * MIN));
  const { state, d } = clocked(dir, () => [claudeProc(11)], [11]);
  const busy = await d.detect(settings);
  assert.equal(busy.sessions[0]!.verdict, 'background');
  assert.equal(busy.aggregate, 'busy');
  state.clock = START + 50 * MIN; // silent for an hour: stuck or killed
  assert.equal((await d.detect(settings)).aggregate, 'idle');
});

test('a scheduled wake-up keeps an idle session on until it is due', async () => {
  const iso = new Date(START).toISOString();
  const lines = [
    JSON.stringify({
      type: 'assistant',
      timestamp: iso,
      message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'w1', name: 'ScheduleWakeup', input: { delaySeconds: 1800 } }] },
    }),
    JSON.stringify({ type: 'user', timestamp: iso, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'scheduled' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: iso, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'see you' }] } }),
  ];
  const dir = claudeDir([{ pid: 11, sessionId: 'w', status: 'idle', procStart: '5000', cwd: 'C:\\work\\app', statusUpdatedAt: START }], { w: lines });
  const { state, d } = clocked(dir, () => [claudeProc(11)], [11]);
  state.clock = START + 10 * MIN;
  const scheduled = await d.detect(settings);
  assert.equal(scheduled.sessions[0]!.verdict, 'scheduled');
  assert.equal(scheduled.aggregate, 'busy');
  state.clock = START + 36 * MIN; // due at +30 min, plus 5 min grace
  assert.equal((await d.detect(settings)).aggregate, 'idle');
});
