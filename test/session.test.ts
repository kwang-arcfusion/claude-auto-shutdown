import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProcInfo } from '../src/main/detector/processes';
import { evaluateSession, parseSessionFile, type EvaluateInput, type ProcessFacts, type SessionFile } from '../src/main/detector/session';
import type { PendingTool } from '../src/main/detector/transcript';
import { render, type Message } from '../src/shared/i18n';
import { DEFAULT_SETTINGS } from '../src/shared/settings';

const text = (message: Message): string => render('en', message);

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const proc = (name: string): ProcInfo => ({ pid: 10, ppid: 1, name, created: 1, cpuTicks: 0, ioBytes: 0, cmd: '' });
const facts = (overrides: Partial<ProcessFacts> = {}): ProcessFacts => ({ tools: [], helperCpuPercent: 0, toolsActiveAt: null, ...overrides });
const pending = (name: string, agoMs: number): PendingTool => ({ id: `toolu_${name}`, name, at: NOW - agoMs });

function input(file: Partial<SessionFile>, overrides: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    file: { pid: 1, sessionId: 's', ...file },
    transcriptState: 'unknown',
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
      waitingFor: 'dialog open',
    }),
  );
  assert.ok(file);
  assert.equal(file.pid, 28348);
  assert.equal(file.status, 'busy');
  assert.equal(file.procStart, '134391962772404597');
  assert.equal(file.waitingFor, 'dialog open');
  assert.equal(file.statusUpdatedAt, 5);
});

test('parseSessionFile rejects junk', () => {
  assert.equal(parseSessionFile('not json'), null);
  assert.equal(parseSessionFile('{"pid":"x","sessionId":"a"}'), null);
  assert.equal(parseSessionFile('{"pid":5}'), null);
  assert.equal(parseSessionFile('null'), null);
});

// ---- the basics -----------------------------------------------------------------------

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

test('without a status field the transcript decides, and unknown counts as busy', () => {
  assert.equal(evaluateSession(input({}, { transcriptState: 'running' })).blocksShutdown, true);
  assert.equal(evaluateSession(input({}, { transcriptState: 'ended' })).blocksShutdown, false);
  assert.equal(evaluateSession(input({}, { transcriptState: 'unknown' })).blocksShutdown, true);
});

// ---- commands Claude started ------------------------------------------------------------

test('an active tool shell blocks, also when the turn is over (background task, status "shell")', () => {
  for (const status of ['idle', 'shell', 'busy']) {
    const r = evaluateSession(input({ status }, { processes: facts({ tools: [proc('bash.exe')], toolsActiveAt: NOW - MIN }) }));
    assert.equal(r.verdict, 'tool', status);
    assert.equal(r.blocksShutdown, true, status);
    assert.match(text(r.reason), /bash\.exe/);
  }
});

test('an active long-running tool is never treated as stalled', () => {
  const r = evaluateSession(
    input({ status: 'busy' }, { lastActivityAt: NOW - 120 * MIN, processes: facts({ tools: [proc('node.exe')], toolsActiveAt: NOW - 2 * MIN }) }),
  );
  assert.equal(r.verdict, 'tool');
});

test('a background command with no activity for toolStallMinutes counts as hung', () => {
  const hung = facts({ tools: [proc('node.exe')], toolsActiveAt: NOW - 21 * MIN });
  const idle = evaluateSession(input({ status: 'idle' }, { processes: hung }));
  assert.equal(idle.verdict, 'stalled');
  assert.equal(idle.blocksShutdown, false);
  assert.match(text(idle.reason), /node\.exe/);

  // A turn still writing to its transcript keeps working, even with a hung command around.
  assert.equal(evaluateSession(input({ status: 'busy' }, { processes: hung })).verdict, 'working');

  // With the rule off, a quiet command keeps the machine on.
  const off = evaluateSession(input({ status: 'idle' }, { processes: hung, settings: { ...DEFAULT_SETTINGS, toolStallMinutes: 0 } }));
  assert.equal(off.verdict, 'tool');
});

// ---- waiting for the user ---------------------------------------------------------------

test('a question to the user waits, then counts as finished after waitingMinutes', () => {
  const recent = evaluateSession(input({ status: 'busy' }, { pendingTools: [pending('AskUserQuestion', 2 * MIN)] }));
  assert.equal(recent.verdict, 'waiting');
  assert.equal(recent.blocksShutdown, true);
  assert.equal(text(recent.reason), 'Waiting for you to answer a question');
  assert.equal(render('th', recent.reason), 'รอผู้ใช้ตอบคำถาม');

  const late = evaluateSession(input({ status: 'busy' }, { pendingTools: [pending('AskUserQuestion', 5 * MIN)] }));
  assert.equal(late.verdict, 'stalled');
  assert.equal(late.blocksShutdown, false);
  assert.equal(text(late.reason), 'Waited over 5 min for you to answer a question, so it counts as finished');

  const plan = evaluateSession(input({ status: 'busy' }, { pendingTools: [pending('ExitPlanMode', MIN)] }));
  assert.match(text(plan.reason), /approve a plan/);
});

test('a Bash call with no shell after the grace period is a permission prompt', () => {
  const bash = [pending('Bash', 3 * MIN)];
  const prompt = evaluateSession(input({ status: 'busy' }, { pendingTools: bash }));
  assert.equal(prompt.verdict, 'waiting');
  assert.match(text(prompt.reason), /allow Bash/);
  assert.match(render('th', prompt.reason), /อนุญาตให้ใช้ Bash/);

  // The shell is running: the command was allowed and is doing its job.
  const running = evaluateSession(input({ status: 'busy' }, { pendingTools: bash, processes: facts({ tools: [proc('bash.exe')], toolsActiveAt: NOW }) }));
  assert.equal(running.verdict, 'tool');

  // Within the grace period the shell may simply not have started yet.
  const fresh = evaluateSession(input({ status: 'busy' }, { pendingTools: [pending('Bash', 20_000)] }));
  assert.equal(fresh.verdict, 'working');

  // Without a process snapshot it cannot tell yet, so it asks for one and keeps blocking.
  const unknown = evaluateSession(input({ status: 'busy' }, { pendingTools: bash, processes: null }));
  assert.equal(unknown.blocksShutdown, true);
  assert.equal(unknown.needsProcessCheck, true);

  const late = evaluateSession(input({ status: 'busy' }, { pendingTools: [pending('Bash', 6 * MIN)] }));
  assert.equal(late.verdict, 'stalled');
});

test('an Edit/Write call still pending after the grace period is a permission prompt; MCP and web tools are not', () => {
  assert.equal(evaluateSession(input({ status: 'busy' }, { pendingTools: [pending('Edit', 2 * MIN)] })).verdict, 'waiting');
  assert.equal(evaluateSession(input({ status: 'busy' }, { pendingTools: [pending('Write', 20_000)] })).verdict, 'working');
  assert.equal(evaluateSession(input({ status: 'busy' }, { pendingTools: [pending('mcp__db__query', 10 * MIN)] })).verdict, 'working');
  assert.equal(evaluateSession(input({ status: 'busy' }, { pendingTools: [pending('WebFetch', 10 * MIN)] })).verdict, 'working');
});

test("Claude Code's own dialogs (waitingFor) wait, then count as finished after waitingMinutes", () => {
  const recent = evaluateSession(input({ status: 'busy', waitingFor: 'dialog open' }));
  assert.equal(recent.verdict, 'waiting');
  const late = evaluateSession(input({ status: 'idle', waitingFor: 'dialog open' }, { lastActivityAt: NOW - 6 * MIN }));
  assert.equal(late.verdict, 'stalled');
  assert.equal(late.blocksShutdown, false);
  assert.equal(text(late.reason), 'Waited over 5 min for you to answer an open dialog, so it counts as finished');
});

test('with waitingMinutes = 0 an unanswered prompt falls back to the long silence rule', () => {
  const settings = { ...DEFAULT_SETTINGS, waitingMinutes: 0 };
  const tenMin = evaluateSession(input({ status: 'busy' }, { settings, lastActivityAt: NOW - 10 * MIN, pendingTools: [pending('AskUserQuestion', 10 * MIN)] }));
  assert.equal(tenMin.verdict, 'waiting');
  assert.equal(tenMin.blocksShutdown, true);
  const fiftyMin = evaluateSession(input({ status: 'busy' }, { settings, lastActivityAt: NOW - 50 * MIN, pendingTools: [pending('AskUserQuestion', 50 * MIN)] }));
  assert.equal(fiftyMin.verdict, 'stalled');
});

test('a pending Bash call is running, not waiting, when anything started after it or helpers are busy', () => {
  const bash = [pending('Bash', 3 * MIN)];
  // A shell without a known marker (or unreadable command lines) still shows up by creation time.
  const startedAfter = evaluateSession(input({ status: 'busy' }, { pendingTools: bash, processes: facts({ newestChildAt: NOW - 3 * MIN + 500 }) }));
  assert.equal(startedAfter.verdict, 'working');
  const startedBefore = evaluateSession(input({ status: 'busy' }, { pendingTools: bash, processes: facts({ newestChildAt: NOW - 60 * MIN }) }));
  assert.equal(startedBefore.verdict, 'waiting');
  const helpersBusy = evaluateSession(input({ status: 'busy' }, { pendingTools: bash, processes: facts({ helpersActiveNow: true }) }));
  assert.equal(helpersBusy.verdict, 'working');
});

// ---- status "shell" (Claude Code says a shell is still running) --------------------------

test('status "shell" without a recognised tool: active descendants block, quiet ones count as hung', () => {
  const active = evaluateSession(input({ status: 'shell' }, { processes: facts({ shellActiveAt: NOW - 2 * MIN }) }));
  assert.equal(active.verdict, 'tool');
  assert.equal(active.blocksShutdown, true);
  const quiet = evaluateSession(input({ status: 'shell' }, { processes: facts({ shellActiveAt: NOW - 21 * MIN }) }));
  assert.equal(quiet.verdict, 'stalled');
  assert.equal(quiet.blocksShutdown, false);

  // Nothing under the session to measure: the long-silence rule decides.
  assert.equal(evaluateSession(input({ status: 'shell' }, { lastActivityAt: NOW - 10 * MIN })).verdict, 'tool');
  assert.equal(evaluateSession(input({ status: 'shell' }, { lastActivityAt: NOW - 50 * MIN })).verdict, 'stalled');

  // Without a process check it cannot tell: it blocks and asks for one.
  const unchecked = evaluateSession(input({ status: 'shell' }, { processes: null }));
  assert.equal(unchecked.blocksShutdown, true);
  assert.equal(unchecked.needsProcessCheck, true);
});

// ---- long silence -----------------------------------------------------------------------

test('busy but silent past stalledMinutes counts as finished once processes are checked', () => {
  const r = evaluateSession(input({ status: 'busy' }, { lastActivityAt: NOW - 50 * MIN }));
  assert.equal(r.verdict, 'stalled');
  assert.equal(r.blocksShutdown, false);
});

test('a stall candidate without a process check asks for one and keeps blocking', () => {
  const r = evaluateSession(input({ status: 'busy' }, { lastActivityAt: NOW - 50 * MIN, processes: null }));
  assert.equal(r.blocksShutdown, true);
  assert.equal(r.needsProcessCheck, true);
});

test('stalledMinutes = 0 never treats a silent busy session as finished', () => {
  const r = evaluateSession(input({ status: 'busy' }, { lastActivityAt: NOW - 600 * MIN, settings: { ...DEFAULT_SETTINGS, stalledMinutes: 0 } }));
  assert.equal(r.verdict, 'working');
});

test('busy helper processes stop a silent busy session from counting as stalled', () => {
  const r = evaluateSession(input({ status: 'busy' }, { lastActivityAt: NOW - 50 * MIN, processes: facts({ helperCpuPercent: 30 }) }));
  assert.equal(r.blocksShutdown, true);
});

// ---- after the turn ---------------------------------------------------------------------

test('a scheduled wake-up keeps an idle session on until it is due (plus a grace period)', () => {
  const due = NOW + 20 * MIN;
  const before = evaluateSession(input({ status: 'idle' }, { scheduledWakeAt: due }));
  assert.equal(before.verdict, 'scheduled');
  assert.equal(before.blocksShutdown, true);
  assert.equal(evaluateSession(input({ status: 'idle' }, { scheduledWakeAt: NOW - 3 * MIN })).verdict, 'scheduled');
  assert.equal(evaluateSession(input({ status: 'idle' }, { scheduledWakeAt: NOW - 6 * MIN })).verdict, 'idle');
});

test('a subagent still mid-turn keeps an idle session busy until it goes quiet for stalledMinutes', () => {
  const working = evaluateSession(input({ status: 'idle' }, { runningSubagentAt: NOW - 10 * MIN }));
  assert.equal(working.verdict, 'background');
  assert.equal(working.blocksShutdown, true);
  assert.equal(evaluateSession(input({ status: 'idle' }, { runningSubagentAt: NOW - 50 * MIN })).verdict, 'idle');
});

test('recent writes in the session folder keep an idle session busy for a short while', () => {
  assert.equal(evaluateSession(input({ status: 'idle' }, { sideActivityAt: NOW - 30_000 })).verdict, 'background');
  assert.equal(evaluateSession(input({ status: 'idle' }, { sideActivityAt: NOW - 5 * MIN })).verdict, 'idle');
});

test('helper CPU above the threshold keeps an idle session busy', () => {
  const r = evaluateSession(input({ status: 'idle' }, { processes: facts({ helperCpuPercent: 12 }) }));
  assert.equal(r.verdict, 'background');
});

test('helper CPU keeps a finished turn on only for toolStallMinutes, and a silent turn for at most 3 hours', () => {
  const busyHelpers = facts({ helperCpuPercent: 30 });
  assert.equal(evaluateSession(input({ status: 'idle', statusUpdatedAt: NOW - 5 * MIN }, { processes: busyHelpers })).verdict, 'background');
  assert.equal(evaluateSession(input({ status: 'idle', statusUpdatedAt: NOW - 25 * MIN }, { processes: busyHelpers })).verdict, 'idle');
  assert.equal(evaluateSession(input({ status: 'busy' }, { lastActivityAt: NOW - 2 * 60 * MIN, processes: busyHelpers })).blocksShutdown, true);
  assert.equal(evaluateSession(input({ status: 'busy' }, { lastActivityAt: NOW - 4 * 60 * MIN, processes: busyHelpers })).verdict, 'stalled');
});

// ---- formats this app does not know (Claude Code updated?) ------------------------------

test('a status this app does not know counts as working, never as finished', () => {
  const r = evaluateSession(input({ status: 'thinking' }, { lastActivityAt: NOW - 10 * MIN }));
  assert.equal(r.verdict, 'working');
  assert.equal(r.blocksShutdown, true);
  assert.equal(r.reason.code, 'reason.unknownStatus');
  assert.equal(text(r.reason), 'Unknown status "thinking", counted as working');

  // Even after a long silence it keeps the PC on; without processes it asks for a check, which
  // can still drop a file left behind by a process that has exited.
  const quiet = evaluateSession(input({ status: 'thinking' }, { lastActivityAt: NOW - 3 * 60 * MIN, processes: null }));
  assert.equal(quiet.blocksShutdown, true);
  assert.equal(quiet.needsProcessCheck, true);
  const checked = evaluateSession(input({ status: 'thinking' }, { lastActivityAt: NOW - 3 * 60 * MIN }));
  assert.equal(checked.blocksShutdown, true);
  assert.equal(checked.needsProcessCheck, false);
});

// ---- Claude Code 2.1.325: status "waiting", versions, schedules -------------------------

test('status "waiting": a prompt or question that counts as finished after waitingMinutes', () => {
  const prompt = evaluateSession(
    input({ status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: NOW - 2 * MIN }, { pendingTools: [pending('Bash', 2 * MIN)] }),
  );
  assert.equal(prompt.verdict, 'waiting');
  assert.equal(prompt.blocksShutdown, true);
  assert.equal(text(prompt.reason), 'Waiting for you to allow Bash');

  const question = evaluateSession(input({ status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: NOW - MIN }));
  assert.equal(text(question.reason), 'Waiting for you to provide input');
  assert.equal(render('th', question.reason), 'รอผู้ใช้ตอบสิ่งที่ถาม');

  // Timed from when the status changed, not from the last transcript write.
  const late = evaluateSession(input({ status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: NOW - 6 * MIN }));
  assert.equal(late.verdict, 'stalled');
  assert.equal(late.blocksShutdown, false);
  assert.equal(text(late.reason), 'Waited over 5 min for you to allow a tool, so it counts as finished');
});

test('a version that reports prompts itself is never guessed to be waiting while "busy"', () => {
  const slowRead = input({ status: 'busy', version: '2.1.325' }, { pendingTools: [pending('Read', 3 * MIN)] });
  assert.equal(evaluateSession(slowRead).verdict, 'working');
  const older = input({ status: 'busy' }, { pendingTools: [pending('Read', 3 * MIN)] });
  assert.equal(evaluateSession(older).verdict, 'waiting');
  // Older versions: a tool that started processes since the call (a hook, ripgrep) is running.
  const hook = input({ status: 'busy' }, { pendingTools: [pending('Edit', 3 * MIN)], processes: facts({ newestChildAt: NOW - 2 * MIN, helpersActiveNow: false }) });
  assert.equal(evaluateSession(hook).verdict, 'working');
});

test('a due CronCreate run keeps the session scheduled until its grace period ends', () => {
  const due = evaluateSession(input({ status: 'idle' }, { cronNextAt: NOW + 20 * MIN, cronUntil: NOW + 55 * MIN }));
  assert.equal(due.verdict, 'scheduled');
  assert.equal(due.blocksShutdown, true);
  assert.equal(evaluateSession(input({ status: 'idle' }, { cronNextAt: NOW - 40 * MIN, cronUntil: NOW - MIN })).verdict, 'idle');
});

test('helper CPU after the turn is limited even when toolStallMinutes is 0', () => {
  const settings = { ...DEFAULT_SETTINGS, toolStallMinutes: 0 };
  const busyHelpers = facts({ helperCpuPercent: 50 });
  assert.equal(evaluateSession(input({ status: 'idle', statusUpdatedAt: NOW - 5 * MIN }, { processes: busyHelpers, settings })).verdict, 'background');
  assert.equal(evaluateSession(input({ status: 'idle', statusUpdatedAt: NOW - 30 * MIN }, { processes: busyHelpers, settings })).verdict, 'idle');
});
