import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CpuSampler, parseSnapshotJson, procKey, type ProcInfo } from '../src/main/detector/processes';
import { classifyDescendants, filetimeToMs, indexProcesses, isToolProcess, processMatchesSession } from '../src/main/detector/tree';

const P = (pid: number, ppid: number, name: string, cmd = '', created = 1000 + pid, cpuTicks = 0): ProcInfo => ({
  pid,
  ppid,
  name,
  cmd,
  created,
  cpuTicks,
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
  const toFiletime = (ms: number): number => (ms + 11_644_473_600_000) * 10_000;
  // The desktop app keeps spare processes, so a process 6 minutes older than the session is normal.
  assert.equal(processMatchesSession({ startedAt }, P(1, 0, 'claude.exe', '', toFiletime(startedAt - 349_294))), true);
  assert.equal(processMatchesSession({ startedAt }, P(1, 0, 'claude.exe', '', toFiletime(startedAt + 60_000))), false);
});

test('filetimeToMs converts a FILETIME to Unix milliseconds', () => {
  assert.equal(Math.round(filetimeToMs(Number('134391962772404597'))), 1_794_722_677_240);
});

test('parseSnapshotJson accepts an array or a single object and skips pid 0', () => {
  const json = JSON.stringify([
    { p: 0, pp: 0, n: 'System Idle Process', c: '0', t: '0', cmd: '' },
    { p: 4, pp: 0, n: 'System', c: '0', t: '123', cmd: null },
    { p: 28348, pp: 22772, n: 'claude.exe', c: '134391962772404597', t: '50000000', cmd: 'claude.exe --output-format stream-json' },
  ]);
  const procs = parseSnapshotJson(json);
  assert.deepEqual(
    procs.map((p) => p.pid),
    [4, 28348],
  );
  assert.equal(procs[1]!.cpuTicks, 50_000_000);
  assert.equal(procs[0]!.cmd, '');
  const single = parseSnapshotJson(`\uFEFF${JSON.stringify({ p: 9, pp: 1, n: 'x.exe', c: '1', t: '2', cmd: 'x' })}`);
  assert.equal(single[0]!.pid, 9);
});

test('CpuSampler reports % of one core between snapshots', () => {
  const sampler = new CpuSampler();
  const a = P(1, 0, 'a.exe', '', 10, 0);
  const b = P(2, 0, 'b.exe', '', 20, 0);
  assert.equal(sampler.update({ at: 1_000, procs: [a, b] }, 60_000), null);
  // 2 s later: a used 1 s of CPU (50 %), b used none, c started in between and used 0.2 s (10 %).
  const c = P(3, 0, 'c.exe', '', 30, 2_000_000);
  const usage = sampler.update({ at: 3_000, procs: [{ ...a, cpuTicks: 10_000_000 }, b, c] }, 60_000);
  assert.ok(usage);
  assert.equal(Math.round(usage.get(procKey(a))!), 50);
  assert.equal(usage.get(procKey(b)), 0);
  assert.equal(Math.round(usage.get(procKey(c))!), 10);
});

test('CpuSampler does not compare with a snapshot that is too old', () => {
  const sampler = new CpuSampler();
  sampler.update({ at: 0, procs: [] }, 1_000);
  assert.equal(sampler.update({ at: 5_000, procs: [] }, 1_000), null);
});
