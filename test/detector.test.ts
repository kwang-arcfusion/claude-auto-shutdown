import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ClaudeDetector } from '../src/main/detector/claude';
import type { ProcInfo, ProcessSnapshot } from '../src/main/detector/processes';
import { DEFAULT_SETTINGS } from '../src/shared/settings';

const BASH_TOOL =
  '"C:\\Program Files\\Git\\bin\\bash.exe" -c "source /c/Users/me/.claude/shell-snapshots/snapshot-bash-1.sh && eval \'npm test\'"';
const MCP_SERVER = 'C:\\Users\\me\\.pencil\\mcp\\out\\mcp-server-windows-x64.exe';
const HOUR = 3_600_000;

interface FakeSession {
  pid: number;
  sessionId: string;
  status?: string;
  procStart?: string;
  cwd?: string;
  statusUpdatedAt?: number;
}

function claudeDir(sessions: FakeSession[], transcripts: Record<string, string[]> = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cas-claude-'));
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
  cmd: 'claude.exe --output-format stream-json',
});
const child = (pid: number, ppid: number, name: string, cmd: string): ProcInfo => ({ pid, ppid, name, created: 6_000, cpuTicks: 0, cmd });

function detector(dir: string, snapshotter: { take(): Promise<ProcessSnapshot> }, alive: number[]): ClaudeDetector {
  return new ClaudeDetector({
    claudeDir: () => dir,
    snapshotter,
    isPidAlive: (pid) => alive.includes(pid),
    sleep: async () => {},
  });
}

const settings = { ...DEFAULT_SETTINGS };

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

test('all idle: processes are checked, with a second snapshot only for the first CPU baseline', async () => {
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
  const snap = new FakeSnapshotter(() => []);
  const r = await detector(path.join(os.tmpdir(), 'cas-does-not-exist-123'), snap, []).detect(settings);
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
