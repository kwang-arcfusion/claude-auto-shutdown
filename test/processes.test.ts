import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActivitySampler, parseSnapshotJson, procKey, type ProcInfo } from '../src/main/detector/processes';
import {
  classifyDescendants,
  filetimeToMs,
  indexProcesses,
  isToolProcess,
  msToFiletime,
  processMatchesSession,
  sessionIdentity,
  sleepEndsAt,
} from '../src/main/detector/tree';

const MIN = 60_000;
const HOUR = 60 * MIN;

const P = (pid: number, ppid: number, name: string, cmd = '', created = 1000 + pid, cpuTicks = 0, ioBytes = 0): ProcInfo => ({
  pid,
  ppid,
  name,
  cmd,
  created,
  cpuTicks,
  ioBytes,
});

// Command lines as seen on Windows with Claude Code 2.1.325 (shortened).
const BASH_TOOL =
  '"C:\\Program Files\\Git\\bin\\bash.exe" -c "source /c/Users/me/.claude/shell-snapshots/snapshot-bash-1.sh 2>/dev/null || true && eval \'sleep 50\'"';
const POWERSHELL_TOOL =
  'C:\\WINDOWS\\System32\\cmd.exe /d /s /c ""C:\\WINDOWS\\System32\\chcp.com" 65001 >nul & "powershell.exe" -NoProfile -Command "$__claudeCodeScript = $env:CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT; Invoke-Expression -Command $__claudeCodeScript"';
const MCP_SERVER = 'C:\\Users\\me\\.pencil\\mcp\\out\\mcp-server-windows-x64.exe --app visual_studio_code';

test('tool signatures match the Bash and PowerShell tool shells but not MCP servers', () => {
  assert.equal(isToolProcess(P(1, 0, 'bash.exe', BASH_TOOL)), true);
  assert.equal(isToolProcess(P(1, 0, 'cmd.exe', POWERSHELL_TOOL)), true);
  assert.equal(isToolProcess(P(1, 0, 'mcp-server-windows-x64.exe', MCP_SERVER)), false);
  assert.equal(isToolProcess(P(1, 0, 'cmd.exe', 'cmd.exe /c npx -y some-mcp-server')), false);
});

test('classifyDescendants splits tools (with their children) from helpers and skips conhost', () => {
  const root = P(100, 1, 'claude.exe', 'claude.exe --output-format stream-json');
  const procs = [
    root,
    P(101, 100, 'conhost.exe'),
    P(102, 100, 'mcp-server-windows-x64.exe', MCP_SERVER),
    P(103, 102, 'conhost.exe'),
    P(104, 100, 'bash.exe', BASH_TOOL),
    P(105, 104, 'bash.exe', BASH_TOOL),
    P(106, 105, 'node.exe', 'node build.js'),
    P(200, 1, 'unrelated.exe'),
  ];
  const { tools, helpers } = classifyDescendants(indexProcesses(procs), root);
  assert.deepEqual(tools.map((p) => p.pid).sort(), [104, 105, 106]);
  assert.deepEqual(helpers.map((p) => p.pid), [102]);
});

test('classifyDescendants ignores children whose parent PID was reused', () => {
  const root = P(100, 1, 'claude.exe', '', 5000);
  const older = P(300, 100, 'bash.exe', BASH_TOOL, 4000); // created before the root process
  const { tools, helpers } = classifyDescendants(indexProcesses([root, older]), root);
  assert.equal(tools.length + helpers.length, 0);
});

test('processMatchesSession compares procStart with the creation time', () => {
  const created = Number('134391962772404597');
  const proc = P(28348, 1, 'claude.exe', '', created);
  assert.equal(processMatchesSession({ procStart: '134391962772404597' }, proc), true);
  assert.equal(processMatchesSession({ procStart: String(created + 50_000_000) }, proc), false); // 5 s apart
  assert.equal(processMatchesSession({ procStart: '134391962772404597' }, undefined), false);
});

test('processMatchesSession falls back to startedAt: the process must not start after the session', () => {
  const startedAt = 1_794_723_026_534;
  // The desktop app keeps spare processes, so a process 6 minutes older than the session is normal.
  assert.equal(processMatchesSession({ startedAt }, P(1, 0, 'claude.exe', '', msToFiletime(startedAt - 349_294))), true);
  assert.equal(processMatchesSession({ startedAt }, P(1, 0, 'claude.exe', '', msToFiletime(startedAt + 60_000))), false);
});

test('sessionIdentity drops a session only with evidence that its file is stale', () => {
  const now = 1_800_000_000_000;
  const file = { procStart: String(msToFiletime(now - HOUR)), updatedAt: now - 10 * MIN };
  assert.equal(sessionIdentity(file, P(1, 0, 'claude.exe', '', msToFiletime(now - HOUR))), 'match');
  assert.equal(sessionIdentity(file, undefined), 'stale');
  // The PID now belongs to a process started after the file was last written: reused.
  assert.equal(sessionIdentity(file, P(1, 0, 'other.exe', '', msToFiletime(now - MIN))), 'stale');
  // A mismatch with no explanation (e.g. a new procStart format) is unsure, never silently stale.
  assert.equal(sessionIdentity({ ...file, procStart: '12345' }, P(1, 0, 'claude.exe', '', msToFiletime(now - HOUR))), 'unsure');
});

test('classifyDescendants reports the newest creation time, console hosts included', () => {
  const root = P(100, 1, 'claude.exe', '', msToFiletime(1_000_000));
  const procs = [root, P(101, 100, 'mcp.exe', '', msToFiletime(2_000_000)), P(102, 100, 'conhost.exe', '', msToFiletime(5_000_000))];
  assert.equal(Math.round(classifyDescendants(indexProcesses(procs), root).newestCreatedAt!), 5_000_000);
});

test('FILETIME conversions', () => {
  assert.equal(Math.round(filetimeToMs(Number('134391962772404597'))), 1_794_722_677_240);
  assert.equal(filetimeToMs(msToFiletime(1_800_000_000_000)), 1_800_000_000_000);
});

test('sleepEndsAt understands timed waits, and nothing else', () => {
  const start = 1_800_000_000_000;
  const at = (name: string, cmd: string): number | null => sleepEndsAt(P(1, 0, name, cmd, msToFiletime(start)));
  assert.equal(at('sleep.exe', 'C:\\Program Files\\Git\\usr\\bin\\sleep.exe 3600'), start + 3_600_000);
  assert.equal(at('sleep.exe', 'sleep 5m'), start + 300_000);
  assert.equal(at('sleep.exe', '"C:\\Program Files\\Git\\usr\\bin\\sleep.exe" 1.5h'), start + 5_400_000);
  assert.equal(at('timeout.exe', 'timeout /t 90 /nobreak'), start + 90_000);
  assert.equal(at('sleep.exe', 'sleep infinity'), null);
  assert.equal(at('node.exe', 'node sleep 3600'), null);
  // A huge wait is trusted for 6 hours at most.
  assert.equal(at('sleep.exe', 'sleep 999999'), start + 6 * 3_600_000);
});

test('parseSnapshotJson accepts an array or a single object, reads I/O and skips pid 0', () => {
  const json = JSON.stringify([
    { p: 0, pp: 0, n: 'System Idle Process', c: '0', t: '0', io: '0', cmd: '' },
    { p: 4, pp: 0, n: 'System', c: '0', t: '123', io: '99', cmd: null },
    { p: 28348, pp: 22772, n: 'claude.exe', c: '134391962772404597', t: '50000000', io: '2048', cmd: 'claude.exe --output-format stream-json' },
  ]);
  const procs = parseSnapshotJson(json);
  assert.deepEqual(
    procs.map((p) => p.pid),
    [4, 28348],
  );
  assert.equal(procs[1]!.cpuTicks, 50_000_000);
  assert.equal(procs[1]!.ioBytes, 2048);
  assert.equal(procs[0]!.cmd, '');
  const single = parseSnapshotJson(`\uFEFF${JSON.stringify({ p: 9, pp: 1, n: 'x.exe', c: '1', t: '2', cmd: 'x' })}`);
  assert.equal(single[0]!.pid, 9);
  assert.equal(single[0]!.ioBytes, 0);
});

test('ActivitySampler reports CPU (% of one core) and I/O rates between snapshots', () => {
  const sampler = new ActivitySampler();
  const a = P(1, 0, 'a.exe', '', 10, 0, 0);
  const b = P(2, 0, 'b.exe', '', 20, 0, 1_000);
  assert.equal(sampler.update({ at: 1_000, procs: [a, b] }, 60_000), null);
  // 2 s later: a used 1 s of CPU (50 %); b moved 4 KB (2 KB/s); c started in between with 0.2 s of CPU.
  const c = P(3, 0, 'c.exe', '', 30, 2_000_000, 0);
  const usage = sampler.update({ at: 3_000, procs: [{ ...a, cpuTicks: 10_000_000 }, { ...b, ioBytes: 5_096 }, c] }, 60_000);
  assert.ok(usage);
  assert.equal(Math.round(usage.get(procKey(a))!.cpuPercent), 50);
  assert.equal(usage.get(procKey(b))!.cpuPercent, 0);
  assert.equal(usage.get(procKey(b))!.ioBytesPerSec, 2_048);
  assert.equal(Math.round(usage.get(procKey(c))!.cpuPercent), 10);
});

test('ActivitySampler does not compare with a snapshot that is too old', () => {
  const sampler = new ActivitySampler();
  sampler.update({ at: 0, procs: [] }, 1_000);
  assert.equal(sampler.update({ at: 5_000, procs: [] }, 1_000), null);
});
