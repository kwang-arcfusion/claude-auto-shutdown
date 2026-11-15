// Accelerated overnight runs. The real detector reads a fake ~/.claude folder and a fake
// process list while simulated time moves forward; the controller polls every 30 s (15 s
// during the countdown) and ticks every second, like the app. A night takes ~1 s to run.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Controller } from '../src/main/controller';
import { ClaudeDetector } from '../src/main/detector/claude';
import type { ProcInfo, ProcessSnapshot } from '../src/main/detector/processes';
import { projectSlug } from '../src/main/detector/transcript';
import { msToFiletime } from '../src/main/detector/tree';
import { DEFAULT_SETTINGS } from '../src/shared/settings';
import type { Phase, Settings } from '../src/shared/types';

const SEC = 1_000;
const MIN = 60 * SEC;
const NIGHT_START = new Date(2026, 10, 15, 23, 0, 0).getTime();

/** "02:40" → that time in the simulated night (times before noon are after midnight). */
function T(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const day = new Date(NIGHT_START);
  if (h < 12) day.setDate(day.getDate() + 1);
  day.setHours(h, m, 0, 0);
  return day.getTime();
}

const clock = (ms: number): string => new Date(ms).toTimeString().slice(0, 8);
const bashTool = (cmd: string): string =>
  `"C:\\Program Files\\Git\\bin\\bash.exe" -c "source /c/Users/me/.claude/shell-snapshots/snapshot-bash-1.sh && eval '${cmd}'"`;

interface FakeSession {
  sessionId: string;
  cwd: string;
  status: 'busy' | 'idle';
  statusUpdatedAt: number;
  transcript: string;
}

/** A process Claude started; cpuShare is the fraction of a core it keeps busy. */
interface FakeTool {
  proc: Omit<ProcInfo, 'cpuTicks' | 'ioBytes'>;
  startedAt: number;
  cpuShare: number;
}

class Night {
  now = NIGHT_START;
  /** Seconds since the last mouse/keyboard input: asleep by default. */
  userIdleSec = 8 * 3600;
  snapshotFails = false;
  readonly actions: number[] = [];
  readonly transitions: Array<{ at: number; phase: Phase }> = [];
  readonly controller: Controller;
  private readonly dir = mkdtempSync(path.join(os.tmpdir(), 'cas-night-'));
  private readonly sessions = new Map<number, FakeSession>();
  private readonly tools = new Map<number, FakeTool[]>();
  private readonly lastToolUse = new Map<number, string>();
  private readonly events: Array<{ at: number; run: () => void }> = [];
  private readonly settings: Settings;
  private nextPid = 50_000;
  private nextId = 1;
  private nextPollAt = NIGHT_START;

  constructor(overrides: Partial<Settings> = {}) {
    mkdirSync(path.join(this.dir, 'sessions'));
    // The expected times below were worked out with a 10-minute confirm and a 20-minute countdown.
    this.settings = { ...DEFAULT_SETTINGS, idleConfirmMinutes: 10, countdownMinutes: 20, ...overrides };
    const detector = new ClaudeDetector({
      claudeDir: () => this.dir,
      snapshotter: { take: async () => this.snapshot() },
      tempRoot: mkdtempSync(path.join(os.tmpdir(), 'cas-night-tmp-')),
      now: () => this.now,
      isPidAlive: (pid) => this.sessions.has(pid),
      sleep: async (ms) => {
        this.now += ms;
      },
    });
    this.controller = new Controller(
      {
        now: () => this.now,
        detect: (settings) => detector.detect(settings),
        runAction: async () => {
          this.actions.push(this.now);
          return { ok: true, command: 'shutdown /s /f /t 0' };
        },
        describeAction: () => 'shutdown /s /f /t 0',
        systemIdleSeconds: () => this.userIdleSec,
        setPreventSleep: () => {},
        notify: () => {},
        saveSettings: () => {},
        persistLog: () => {},
        onChange: () => {},
        defaultClaudeDir: this.dir,
      },
      this.settings,
    );
  }

  // ---- timeline ----------------------------------------------------------------
  at(hhmm: string, run: () => void): this {
    this.events.push({ at: T(hhmm), run });
    return this;
  }

  /** A busy stretch: one finished tool step every 2 minutes. */
  working(pid: number, from: string, to: string): this {
    for (let t = T(from); t < T(to); t += 2 * MIN) this.events.push({ at: t, run: () => this.step(pid) });
    return this;
  }

  /** A subagent that writes a step every 2 minutes. */
  subagentWorking(pid: number, agent: string, from: string, to: string): this {
    for (let t = T(from); t < T(to); t += 2 * MIN) this.events.push({ at: t, run: () => this.subagentStep(pid, agent) });
    return this;
  }

  // ---- what Claude does ------------------------------------------------------------
  open(pid: number, project: string): void {
    const cwd = `C:\\work\\${project}`;
    const transcript = path.join(this.dir, 'projects', projectSlug(cwd), `session-${pid}.jsonl`);
    mkdirSync(path.dirname(transcript), { recursive: true });
    writeFileSync(transcript, '');
    this.sessions.set(pid, { sessionId: `session-${pid}`, cwd, status: 'idle', statusUpdatedAt: this.now, transcript });
    this.writeSessionFile(pid);
    this.touch(transcript);
  }

  prompt(pid: number): void {
    this.setStatus(pid, 'busy');
    this.append(pid, { type: 'user', message: { role: 'user', content: 'continue the task' } });
  }

  /** One complete tool step: the call and its result. */
  step(pid: number): void {
    const id = this.callTool(pid, 'Edit');
    this.toolResult(pid, id);
  }

  reply(pid: number): void {
    this.append(pid, { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } });
    this.append(pid, { type: 'system', subtype: 'stop_hook_summary' });
    this.setStatus(pid, 'idle');
  }

  /** A foreground command; cpuShare 0.5 = a build keeping half a core busy. */
  toolStart(pid: number, cmd: string, cpuShare = 0.5): void {
    this.callTool(pid, 'Bash');
    this.addTool(pid, cmd, cpuShare);
  }

  toolEnd(pid: number): void {
    this.tools.delete(pid);
    this.toolResult(pid, this.lastToolUse.get(pid)!);
  }

  /** Asks for permission to run a command, and nobody is awake to answer. */
  waitForPermission(pid: number): void {
    this.callTool(pid, 'Bash');
  }

  /** Asks the user a question (AskUserQuestion), and nobody answers. */
  askUser(pid: number): void {
    this.callTool(pid, 'AskUserQuestion');
  }

  /** A run_in_background command that keeps going after the turn ends. */
  backgroundStart(pid: number, cmd: string, options: { cpuShare?: number; sleepSeconds?: number } = {}): void {
    const id = this.callTool(pid, 'Bash');
    const shell = this.addTool(pid, cmd, options.cpuShare ?? 0);
    if (options.sleepSeconds !== undefined) {
      this.tools.get(pid)!.push({
        proc: { pid: this.nextPid++, ppid: shell.pid, name: 'sleep.exe', created: msToFiletime(this.now), cmd: `sleep ${options.sleepSeconds}` },
        startedAt: this.now,
        cpuShare: 0,
      });
    }
    this.toolResult(pid, id, 'Command running in background');
  }

  backgroundEnd(pid: number): void {
    this.tools.delete(pid);
  }

  /** Starts a background agent: the main turn can end while the subagent keeps working. */
  spawnBackgroundAgent(pid: number, agent: string): void {
    const id = this.callTool(pid, 'Agent');
    this.toolResult(pid, id, 'Agent running in background');
    this.subagentStep(pid, agent);
  }

  subagentStep(pid: number, agent: string): void {
    const id = `toolu_${this.nextId++}`;
    this.subagentAppend(pid, agent, { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Read' }] } });
    this.subagentAppend(pid, agent, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
  }

  subagentEnd(pid: number, agent: string): void {
    this.subagentAppend(pid, agent, { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'report' }] } });
  }

  /** ScheduleWakeup (as /loop does), then ends the turn. stop: true ends the loop. */
  scheduleWakeup(pid: number, input: { delaySeconds?: number; stop?: boolean }): void {
    const id = this.callTool(pid, 'ScheduleWakeup', input);
    this.toolResult(pid, id, 'scheduled');
    this.reply(pid);
  }

  /** The process dies and leaves its session file behind (still saying busy). */
  crash(pid: number): void {
    this.sessions.delete(pid);
    this.tools.delete(pid);
  }

  // ---- simulation loop ------------------------------------------------------------
  async run(until = '07:00'): Promise<void> {
    const end = T(until);
    this.events.sort((a, b) => a.at - b.at);
    this.controller.arm();
    this.record();
    while (this.now < end && this.actions.length === 0) {
      while (this.events.length > 0 && this.events[0]!.at <= this.now) this.events.shift()!.run();
      if (this.now >= this.nextPollAt) {
        await this.controller.poll();
        const every = this.settings.pollIntervalSec * SEC;
        this.nextPollAt = this.now + (this.controller.getPhase() === 'countdown' ? Math.min(every, 15 * SEC) : every);
        this.record();
      }
      this.controller.tick();
      await this.controller.settled();
      this.record();
      if (this.actions.length > 0) break; // the machine is off
      const nextEvent = this.events[0]?.at ?? Number.POSITIVE_INFINITY;
      const inCountdown = this.controller.getPhase() === 'countdown';
      this.now += inCountdown ? SEC : Math.max(SEC, Math.min(this.nextPollAt, nextEvent) - this.now);
    }
  }

  // ---- assertions ---------------------------------------------------------------
  expectShutdownBetween(from: string, to: string): void {
    assert.equal(this.actions.length, 1, `expected one shutdown, got: ${this.actions.map(clock).join(', ') || 'none'}`);
    const at = this.actions[0]!;
    assert.ok(at >= T(from) && at <= T(to), `shut down at ${clock(at)}, expected between ${from} and ${to}`);
  }

  expectNoShutdown(): void {
    assert.equal(this.actions.length, 0, `unexpected shutdown at ${this.actions.map(clock).join(', ')}`);
  }

  expectNoCountdownBefore(hhmm: string): void {
    const early = this.transitions.find((t) => t.phase === 'countdown' && t.at < T(hhmm));
    assert.equal(early, undefined, `countdown started too early, at ${early ? clock(early.at) : ''}`);
  }

  countdownStarts(): string[] {
    return this.transitions.filter((t) => t.phase === 'countdown').map((t) => clock(t.at));
  }

  // ---- internals ------------------------------------------------------------------
  private record(): void {
    const phase = this.controller.getPhase();
    if (this.transitions.at(-1)?.phase !== phase) this.transitions.push({ at: this.now, phase });
  }

  private callTool(pid: number, name: string, input: object = {}): string {
    const id = `toolu_${this.nextId++}`;
    this.lastToolUse.set(pid, id);
    this.append(pid, { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] } });
    return id;
  }

  private toolResult(pid: number, id: string, content = 'ok'): void {
    this.append(pid, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
  }

  private writeSessionFile(pid: number): void {
    const s = this.sessions.get(pid)!;
    writeFileSync(
      path.join(this.dir, 'sessions', `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId: s.sessionId,
        cwd: s.cwd,
        name: path.win32.basename(s.cwd),
        procStart: String(pid * 1_000),
        status: s.status,
        statusUpdatedAt: s.statusUpdatedAt,
        updatedAt: s.statusUpdatedAt,
        entrypoint: 'claude-desktop',
        kind: 'interactive',
      }),
    );
  }

  private setStatus(pid: number, status: 'busy' | 'idle'): void {
    const s = this.sessions.get(pid)!;
    s.status = status;
    s.statusUpdatedAt = this.now;
    this.writeSessionFile(pid);
  }

  private append(pid: number, entry: object): void {
    const s = this.sessions.get(pid)!;
    appendFileSync(s.transcript, `${JSON.stringify({ ...entry, timestamp: new Date(this.now).toISOString() })}\n`);
    this.touch(s.transcript);
  }

  private subagentAppend(pid: number, agent: string, entry: object): void {
    const s = this.sessions.get(pid)!;
    const file = path.join(path.dirname(s.transcript), s.sessionId, 'subagents', `agent-${agent}.jsonl`);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ ...entry, timestamp: new Date(this.now).toISOString() })}\n`);
    this.touch(file);
  }

  private touch(file: string): void {
    const time = new Date(this.now);
    utimesSync(file, time, time);
  }

  private addTool(pid: number, cmd: string, cpuShare: number): Omit<ProcInfo, 'cpuTicks' | 'ioBytes'> {
    const proc = { pid: this.nextPid++, ppid: pid, name: 'bash.exe', created: msToFiletime(this.now), cmd: bashTool(cmd) };
    this.tools.set(pid, [...(this.tools.get(pid) ?? []), { proc, startedAt: this.now, cpuShare }]);
    return proc;
  }

  private snapshot(): ProcessSnapshot {
    if (this.snapshotFails) throw new Error('powershell.exe failed to start');
    const procs: ProcInfo[] = [];
    for (const pid of this.sessions.keys()) {
      procs.push({ pid, ppid: 1, name: 'claude.exe', created: pid * 1_000, cpuTicks: 0, ioBytes: 0, cmd: 'claude.exe --output-format stream-json' });
      procs.push({ pid: pid + 1, ppid: pid, name: 'mcp-server.exe', created: pid * 1_000 + 1, cpuTicks: 0, ioBytes: 0, cmd: 'mcp-server.exe --stdio' });
      for (const tool of this.tools.get(pid) ?? []) {
        procs.push({ ...tool.proc, cpuTicks: Math.round((this.now - tool.startedAt) * 10_000 * tool.cpuShare), ioBytes: 0 });
      }
    }
    return { at: this.now, procs };
  }
}

const start = (night: Night, pid = 100, project = 'app'): void => {
  night.open(pid, project);
  night.prompt(pid);
};

// ---- the original scenarios -----------------------------------------------------------

test('normal night: a 60-minute build keeps it on; shutdown 30 min after the last session', async () => {
  const night = new Night();
  night
    .at('23:00', () => {
      start(night, 100, 'api');
      start(night, 200, 'web');
    })
    .working(100, '23:00', '00:10')
    .at('00:10', () => night.toolStart(100, 'npm run build:all')) // transcript silent for an hour, CPU busy
    .at('01:10', () => night.toolEnd(100))
    .working(100, '01:10', '02:10')
    .at('02:10', () => night.reply(100))
    .working(200, '23:00', '00:30')
    .at('00:30', () => night.reply(200));
  await night.run();
  night.expectNoCountdownBefore('02:10');
  night.expectShutdownBetween('02:40', '02:42');
});

test('a busy background task keeps the machine on after the turn ends, and Claude resumes by itself', async () => {
  const night = new Night();
  night
    .at('23:00', () => start(night))
    .working(100, '23:00', '00:00')
    .at('00:00', () => night.backgroundStart(100, 'python train.py', { cpuShare: 0.8 }))
    .at('00:01', () => night.reply(100))
    .at('01:20', () => {
      night.backgroundEnd(100);
      night.prompt(100); // woken by the finished task
    })
    .working(100, '01:20', '01:40')
    .at('01:40', () => night.reply(100));
  await night.run();
  night.expectNoCountdownBefore('01:40');
  night.expectShutdownBetween('02:10', '02:12');
});

test('Claude starting again during the countdown cancels it', async () => {
  const night = new Night();
  night
    .at('23:00', () => start(night))
    .working(100, '23:00', '00:30')
    .at('00:30', () => night.reply(100))
    .at('00:50', () => night.prompt(100)) // a queued follow-up starts mid-countdown
    .working(100, '00:50', '01:15')
    .at('01:15', () => night.reply(100));
  await night.run();
  const starts = night.countdownStarts();
  assert.equal(starts.length, 2, `countdowns started at: ${starts.join(', ')}`);
  assert.ok(starts[0]! >= '00:40:00' && starts[0]! <= '00:42:00', `first countdown at ${starts[0]}`);
  night.expectShutdownBetween('01:45', '01:47');
});

test('someone using the computer during the countdown disarms for the night', async () => {
  const night = new Night();
  night
    .at('23:00', () => start(night))
    .working(100, '23:00', '00:30')
    .at('00:30', () => night.reply(100))
    .at('00:45', () => {
      night.userIdleSec = 0; // the mouse moved
    });
  await night.run('07:00');
  assert.equal(night.countdownStarts().length, 1);
  assert.equal(night.controller.getPhase(), 'disarmed');
  night.expectNoShutdown();
});

test('if process inspection breaks, the machine stays on (never guesses idle)', async () => {
  const night = new Night();
  night
    .at('23:00', () => start(night))
    .working(100, '23:00', '00:30')
    .at('00:20', () => {
      night.snapshotFails = true;
    })
    .at('00:30', () => night.reply(100));
  await night.run('07:00');
  night.expectNoShutdown();
  const last = night.controller.state().lastDetection;
  assert.equal(last?.aggregate, 'unknown');
  assert.match(last?.error ?? '', /powershell/);
});

test('if the Claude process dies mid-turn, its leftover "busy" file is ignored', async () => {
  const night = new Night();
  night
    .at('23:00', () => start(night))
    .working(100, '23:00', '01:00')
    .at('01:00', () => night.crash(100));
  await night.run();
  night.expectShutdownBetween('01:30', '01:32');
});

test('25 minutes of silent thinking is not treated as finished', async () => {
  const night = new Night();
  night
    .at('23:00', () => start(night))
    .working(100, '23:00', '23:30')
    .working(100, '23:55', '00:30') // nothing written between 23:30 and 23:55
    .at('00:30', () => night.reply(100));
  await night.run();
  night.expectNoCountdownBefore('00:30');
  night.expectShutdownBetween('01:00', '01:02');
});

// ---- waiting for an answer ----------------------------------------------------------------

test('an unanswered permission prompt counts as finished after 5 minutes', async () => {
  const night = new Night();
  night
    .at('23:00', () => start(night))
    .working(100, '23:00', '00:30')
    .at('00:30', () => night.waitForPermission(100));
  await night.run();
  night.expectNoCountdownBefore('00:45');
  night.expectShutdownBetween('01:05', '01:07');
});

test('an unanswered question counts as finished after 5 minutes', async () => {
  const night = new Night();
  night
    .at('23:00', () => start(night))
    .working(100, '23:00', '00:30')
    .at('00:30', () => night.askUser(100));
  await night.run();
  night.expectShutdownBetween('01:05', '01:07');
});

test('with every timeout turned off, an unanswered prompt keeps the machine on all night', async () => {
  const night = new Night({ waitingMinutes: 0, stalledMinutes: 0 });
  night
    .at('23:00', () => start(night))
    .working(100, '23:00', '00:30')
    .at('00:30', () => night.waitForPermission(100));
  await night.run('07:00');
  night.expectNoShutdown();
});

// ---- background tasks ----------------------------------------------------------------------

test('a background dev server that just sits there counts as hung after 20 quiet minutes', async () => {
  const night = new Night();
  night
    .at('23:00', () => start(night))
    .working(100, '23:00', '23:30')
    .at('23:30', () => night.backgroundStart(100, 'npm run dev', { cpuShare: 0 }))
    .at('23:31', () => night.reply(100));
  await night.run();
  night.expectNoCountdownBefore('23:51');
  night.expectShutdownBetween('00:21', '00:23');
});

test('a timed background sleep is waited out; Claude then carries on and finishes', async () => {
  const night = new Night();
  night
    .at('23:00', () => start(night))
    .working(100, '23:00', '23:30')
    .at('23:30', () => night.backgroundStart(100, 'sleep 3600 && gh run view', { sleepSeconds: 3600 }))
    .at('23:31', () => night.reply(100))
    .at('00:30', () => {
      night.backgroundEnd(100);
      night.prompt(100);
    })
    .working(100, '00:30', '00:40')
    .at('00:40', () => night.reply(100));
  await night.run();
  night.expectNoCountdownBefore('00:40');
  night.expectShutdownBetween('01:10', '01:12');
});

test('a background agent keeps working (with a 40-minute silence) after the main turn ends', async () => {
  const night = new Night();
  night
    .at('23:00', () => start(night))
    .working(100, '23:00', '00:30')
    .at('00:30', () => {
      night.spawnBackgroundAgent(100, 'a1');
      night.reply(100);
    })
    .subagentWorking(100, 'a1', '00:32', '01:00')
    .subagentWorking(100, 'a1', '01:40', '02:00') // silent 01:00–01:40 while it thinks
    .at('02:00', () => night.subagentEnd(100, 'a1'));
  await night.run();
  night.expectNoCountdownBefore('02:00');
  night.expectShutdownBetween('02:31', '02:33');
});

// ---- loops ---------------------------------------------------------------------------------

test('a /loop with scheduled wake-ups keeps the machine on until the loop stops', async () => {
  const night = new Night();
  night
    .at('23:00', () => start(night))
    .working(100, '23:00', '23:30')
    .at('23:30', () => night.scheduleWakeup(100, { delaySeconds: 1800 })) // wakes at 00:00
    .at('00:00', () => night.prompt(100))
    .working(100, '00:00', '00:10')
    .at('00:10', () => night.scheduleWakeup(100, { delaySeconds: 1200 })) // wakes at 00:30
    .at('00:30', () => night.prompt(100))
    .working(100, '00:30', '00:40')
    .at('00:40', () => night.scheduleWakeup(100, { stop: true }));
  await night.run();
  night.expectNoCountdownBefore('00:40');
  night.expectShutdownBetween('01:10', '01:12');
});
