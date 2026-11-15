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
  private readonly tools = new Map<number, ProcInfo[]>();
  private readonly events: Array<{ at: number; run: () => void }> = [];
  private readonly settings: Settings;
  private nextToolPid = 50_000;
  private nextPollAt = NIGHT_START;

  constructor(overrides: Partial<Settings> = {}) {
    mkdirSync(path.join(this.dir, 'sessions'));
    this.settings = { ...DEFAULT_SETTINGS, ...overrides };
    const detector = new ClaudeDetector({
      claudeDir: () => this.dir,
      snapshotter: { take: async () => this.snapshot() },
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

  /** A busy stretch: the session writes to its transcript every 2 minutes. */
  working(pid: number, from: string, to: string): this {
    for (let t = T(from); t < T(to); t += 2 * MIN) this.events.push({ at: t, run: () => this.progress(pid) });
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

  progress(pid: number): void {
    this.append(pid, { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Edit' }] } });
  }

  reply(pid: number): void {
    this.append(pid, { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } });
    this.append(pid, { type: 'system', subtype: 'stop_hook_summary' });
    this.setStatus(pid, 'idle');
  }

  toolStart(pid: number, cmd: string): void {
    this.append(pid, { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] } });
    this.addTool(pid, cmd);
  }

  toolEnd(pid: number): void {
    this.tools.delete(pid);
    this.append(pid, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });
  }

  /** Asks for permission and then nothing happens, because nobody is awake to answer. */
  waitForPermission(pid: number): void {
    this.append(pid, { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] } });
  }

  /** A run_in_background shell that keeps going after the turn ends. */
  backgroundStart(pid: number, cmd: string): void {
    this.toolStart(pid, cmd);
    this.append(pid, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'running in background' }] } });
  }

  backgroundEnd(pid: number): void {
    this.tools.delete(pid);
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
    appendFileSync(s.transcript, `${JSON.stringify(entry)}\n`);
    this.touch(s.transcript);
  }

  private touch(file: string): void {
    const time = new Date(this.now);
    utimesSync(file, time, time);
  }

  private addTool(pid: number, cmd: string): void {
    const shell: ProcInfo = { pid: this.nextToolPid++, ppid: pid, name: 'bash.exe', created: pid * 1_000 + 500, cpuTicks: 0, cmd: bashTool(cmd) };
    this.tools.set(pid, [...(this.tools.get(pid) ?? []), shell]);
  }

  private snapshot(): ProcessSnapshot {
    if (this.snapshotFails) throw new Error('powershell.exe failed to start');
    const procs: ProcInfo[] = [];
    for (const pid of this.sessions.keys()) {
      procs.push({ pid, ppid: 1, name: 'claude.exe', created: pid * 1_000, cpuTicks: 0, cmd: 'claude.exe --output-format stream-json' });
      procs.push({ pid: pid + 1, ppid: pid, name: 'mcp-server.exe', created: pid * 1_000 + 1, cpuTicks: 0, cmd: 'mcp-server.exe --stdio' });
      procs.push(...(this.tools.get(pid) ?? []));
    }
    return { at: this.now, procs };
  }
}

test('normal night: a 60-minute silent build is not mistaken for idle; shutdown 30 min after the last session', async () => {
  const night = new Night();
  night
    .at('23:00', () => {
      night.open(100, 'api');
      night.open(200, 'web');
      night.prompt(100);
      night.prompt(200);
    })
    .working(100, '23:00', '00:10')
    .at('00:10', () => night.toolStart(100, 'npm run build:all')) // transcript silent for an hour
    .at('01:10', () => night.toolEnd(100))
    .working(100, '01:10', '02:10')
    .at('02:10', () => night.reply(100))
    .working(200, '23:00', '00:30')
    .at('00:30', () => night.reply(200));
  await night.run();
  night.expectNoCountdownBefore('02:10');
  night.expectShutdownBetween('02:40', '02:42');
});

test('a background task keeps the machine on after the turn ends, and Claude resumes by itself', async () => {
  const night = new Night();
  night
    .at('23:00', () => {
      night.open(100, 'ml');
      night.prompt(100);
    })
    .working(100, '23:00', '00:00')
    .at('00:00', () => night.backgroundStart(100, 'python train.py'))
    .at('00:01', () => night.reply(100)) // status idle, training still running
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
    .at('23:00', () => {
      night.open(100, 'app');
      night.prompt(100);
    })
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

test('a session stuck on a permission prompt counts as finished after 45 quiet minutes', async () => {
  const night = new Night();
  night
    .at('23:00', () => {
      night.open(100, 'app');
      night.prompt(100);
    })
    .working(100, '23:00', '00:30')
    .at('00:30', () => night.waitForPermission(100));
  await night.run();
  night.expectNoCountdownBefore('01:15');
  night.expectShutdownBetween('01:45', '01:47');
});

test('with the stall rule off, a stuck session keeps the machine on all night', async () => {
  const night = new Night({ stalledMinutes: 0 });
  night
    .at('23:00', () => {
      night.open(100, 'app');
      night.prompt(100);
    })
    .working(100, '23:00', '00:30')
    .at('00:30', () => night.waitForPermission(100));
  await night.run('07:00');
  night.expectNoShutdown();
});

test('someone using the computer during the countdown disarms for the night', async () => {
  const night = new Night();
  night
    .at('23:00', () => {
      night.open(100, 'app');
      night.prompt(100);
    })
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
    .at('23:00', () => {
      night.open(100, 'app');
      night.prompt(100);
    })
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
    .at('23:00', () => {
      night.open(100, 'app');
      night.prompt(100);
    })
    .working(100, '23:00', '01:00')
    .at('01:00', () => night.crash(100));
  await night.run();
  night.expectShutdownBetween('01:30', '01:32');
});

test('25 minutes of silent thinking is not treated as finished', async () => {
  const night = new Night();
  night
    .at('23:00', () => {
      night.open(100, 'app');
      night.prompt(100);
    })
    .working(100, '23:00', '23:30')
    .working(100, '23:55', '00:30') // nothing written between 23:30 and 23:55
    .at('00:30', () => night.reply(100));
  await night.run();
  night.expectNoCountdownBefore('00:30');
  night.expectShutdownBetween('01:00', '01:02');
});
