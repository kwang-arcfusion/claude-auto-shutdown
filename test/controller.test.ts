import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Controller, type ActionResult, type ControllerDeps } from '../src/main/controller';
import { msg, renderEntry } from '../src/shared/i18n';
import { DEFAULT_SETTINGS } from '../src/shared/settings';
import type { Aggregate, LogEntry, SessionInfo, Settings } from '../src/shared/types';

const MIN = 60_000;

const busySession = (now: number, lastActivityAt = now): SessionInfo => ({
  pid: 7,
  sessionId: 's',
  name: 'demo',
  cwd: 'C:\\work',
  entrypoint: 'claude-desktop',
  status: 'busy',
  waitingFor: null,
  verdict: 'working',
  blocksShutdown: true,
  reason: msg('reason.working'),
  lastActivityAt,
  transcriptState: 'running',
  toolProcesses: [],
  helperCpuPercent: null,
  processesChecked: false,
});

function harness(
  overrides: Partial<Settings> = {},
  options: { dryRunForced?: boolean; actionResult?: ActionResult; maxTickGapMs?: number; saveFails?: boolean } = {},
) {
  let now = 1_000_000;
  let aggregate: Aggregate = 'busy';
  let idleSeconds = 100_000;
  const scripted: Aggregate[] = [];
  const actions: boolean[] = [];
  const notifications: string[] = [];
  const preventSleep: boolean[] = [];
  const log: LogEntry[] = [];
  const thoroughCalls: boolean[] = [];
  const deps: ControllerDeps = {
    now: () => now,
    // Like the real detector: a files-only check cannot verify idleness, so it is partial.
    detect: async (_settings, thorough) => {
      thoroughCalls.push(thorough);
      const current = scripted.shift() ?? aggregate;
      return {
        at: now,
        aggregate: current,
        // A busy result always has a session at work, active just now.
        sessions: current === 'busy' ? [busySession(now)] : [],
        error: current === 'unknown' ? msg('app.checkFailed', { detail: 'detector failed' }) : null,
        claudeDir: 'C:\\claude',
        usedProcessSnapshot: false,
        partial: !thorough && current !== 'busy' ? true : undefined,
        durationMs: 0,
      };
    },
    runAction: async (_settings, dryRun) => {
      actions.push(dryRun);
      return options.actionResult ?? { ok: true, command: 'shutdown /s /f /t 0' };
    },
    describeAction: () => 'shutdown /s /f /t 0',
    systemIdleSeconds: () => idleSeconds,
    setPreventSleep: (on) => preventSleep.push(on),
    notify: (title) => notifications.push(title.code),
    saveSettings: () => {
      if (options.saveFails) throw new Error('EBUSY: file is locked');
    },
    persistLog: (entry) => log.push(entry),
    onChange: () => {},
    defaultClaudeDir: 'C:\\claude',
    // These tests jump the clock between ticks; the gap check gets its own test.
    maxTickGapMs: options.maxTickGapMs ?? Number.POSITIVE_INFINITY,
  };
  const controller = new Controller(
    deps,
    { ...DEFAULT_SETTINGS, idleConfirmMinutes: 10, countdownMinutes: 20, ...overrides },
    options.dryRunForced ?? false,
  );
  return {
    controller,
    actions,
    notifications,
    preventSleep,
    log,
    thoroughCalls,
    advance: (ms: number) => {
      now += ms;
    },
    set: (next: Aggregate) => {
      aggregate = next;
    },
    /** The next detections return these, in order, before falling back to set(). */
    script: (...next: Aggregate[]) => {
      scripted.push(...next);
    },
    setIdleSeconds: (seconds: number) => {
      idleSeconds = seconds;
    },
    /** Lets fire-and-forget promises (the final check) finish. */
    settle: async () => {
      for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

/** Arms and drives the controller into the countdown (needs idleConfirmMinutes: 0). */
async function intoCountdown(h: ReturnType<typeof harness>): Promise<void> {
  h.controller.arm();
  h.set('idle');
  await h.controller.poll();
  assert.equal(h.controller.getPhase(), 'countdown');
}

test('never acts while disarmed', async () => {
  const h = harness();
  h.set('idle');
  for (let i = 0; i < 10; i++) {
    await h.controller.poll();
    h.advance(30 * MIN);
    h.controller.tick();
  }
  await h.settle();
  assert.equal(h.controller.getPhase(), 'disarmed');
  assert.equal(h.actions.length, 0);
});

test('full cycle: idle for the confirm window, then countdown, final check and action', async () => {
  const h = harness();
  h.controller.arm();
  assert.equal(h.controller.getPhase(), 'monitoring');
  assert.deepEqual(h.preventSleep, [true]);

  h.set('idle');
  await h.controller.poll();
  h.advance(9 * MIN);
  await h.controller.poll();
  assert.equal(h.controller.getPhase(), 'monitoring');
  h.advance(1 * MIN);
  await h.controller.poll();
  assert.equal(h.controller.getPhase(), 'countdown');
  assert.equal(h.notifications.length, 1);

  h.advance(19 * MIN);
  h.controller.tick();
  await h.settle();
  assert.equal(h.actions.length, 0);

  h.advance(1 * MIN);
  h.controller.tick();
  await h.settle();
  assert.deepEqual(h.actions, [false]);
  assert.equal(h.controller.getPhase(), 'executing');
  assert.equal(h.preventSleep.at(-1), false); // our own blocker is released before acting
});

test('activity restarts the confirmation window', async () => {
  const h = harness();
  h.controller.arm();
  h.set('idle');
  await h.controller.poll();
  h.advance(8 * MIN);
  h.set('busy');
  await h.controller.poll();
  assert.equal(h.controller.state().idleSince, null);
  h.set('idle');
  h.advance(1 * MIN);
  await h.controller.poll();
  h.advance(9 * MIN);
  await h.controller.poll();
  assert.equal(h.controller.getPhase(), 'monitoring'); // only 9 minutes since the reset
  h.advance(1 * MIN);
  await h.controller.poll();
  assert.equal(h.controller.getPhase(), 'countdown');
});

test('activity during the countdown goes back to monitoring', async () => {
  const h = harness({ idleConfirmMinutes: 0 });
  await intoCountdown(h);
  h.set('busy');
  await h.controller.poll();
  assert.equal(h.controller.getPhase(), 'monitoring');
  h.advance(30 * MIN);
  h.controller.tick();
  await h.settle();
  assert.equal(h.actions.length, 0);
});

test('a final check that finds work does not act', async () => {
  const h = harness({ idleConfirmMinutes: 0 });
  await intoCountdown(h);
  h.set('busy');
  h.advance(20 * MIN);
  h.controller.tick();
  await h.settle();
  assert.equal(h.controller.getPhase(), 'monitoring');
  assert.equal(h.actions.length, 0);
});

test('unknown status keeps counting, but the final check must pass: three failures cancel', async () => {
  const h = harness({ idleConfirmMinutes: 0 });
  await intoCountdown(h);
  h.set('unknown');
  await h.controller.poll();
  assert.equal(h.controller.getPhase(), 'countdown');
  h.advance(20 * MIN);
  for (let attempt = 0; attempt < 3; attempt++) {
    h.controller.tick();
    await h.settle();
    h.advance(15_000);
  }
  assert.equal(h.controller.getPhase(), 'monitoring');
  assert.equal(h.actions.length, 0);
});

test('mouse or keyboard input during the countdown disarms', async () => {
  const h = harness({ idleConfirmMinutes: 0 });
  await intoCountdown(h);
  h.advance(10_000);
  h.setIdleSeconds(1); // input 1 s ago, 10 s into the countdown
  h.controller.tick();
  assert.equal(h.controller.getPhase(), 'disarmed');
  assert.equal(h.preventSleep.at(-1), false);
});

test('input from before the countdown started is ignored', async () => {
  const h = harness({ idleConfirmMinutes: 0 });
  await intoCountdown(h);
  h.setIdleSeconds(3600);
  h.advance(10_000);
  h.controller.tick();
  assert.equal(h.controller.getPhase(), 'countdown');
});

test('user activity is ignored when the setting is off', async () => {
  const h = harness({ idleConfirmMinutes: 0, cancelOnUserActivity: false });
  await intoCountdown(h);
  h.advance(10_000);
  h.setIdleSeconds(0);
  h.controller.tick();
  assert.equal(h.controller.getPhase(), 'countdown');
});

test('dry run (setting or --dry-run) logs instead of acting and disarms', async () => {
  for (const variant of [{ overrides: { dryRun: true } }, { overrides: {}, dryRunForced: true }]) {
    const h = harness({ idleConfirmMinutes: 0, countdownMinutes: 1, ...variant.overrides }, { dryRunForced: variant.dryRunForced });
    await intoCountdown(h);
    h.advance(1 * MIN);
    h.controller.tick();
    await h.settle();
    assert.deepEqual(h.actions, [true]);
    assert.equal(h.controller.getPhase(), 'disarmed');
    assert.ok(h.log.some((entry) => entry.code === 'log.dryRunAction' && renderEntry('en', entry).includes('[Test mode]')));
  }
});

test('a failed action disarms and logs an error', async () => {
  const h = harness({ idleConfirmMinutes: 0, countdownMinutes: 0 }, { actionResult: { ok: false, command: 'shutdown /s /f /t 0', error: 'Access is denied.' } });
  await intoCountdown(h);
  h.advance(MIN); // a real action always gets at least a minute of countdown
  h.controller.tick();
  await h.settle();
  assert.equal(h.controller.getPhase(), 'disarmed');
  assert.ok(h.log.some((entry) => entry.level === 'error' && renderEntry('en', entry).includes('Access is denied.')));
});

test('cancel during the countdown disarms', async () => {
  const h = harness({ idleConfirmMinutes: 0 });
  await intoCountdown(h);
  h.controller.cancel();
  assert.equal(h.controller.getPhase(), 'disarmed');
});

test('waking from sleep during the countdown restarts the confirmation', async () => {
  const h = harness({ idleConfirmMinutes: 0 });
  await intoCountdown(h);
  h.controller.onResume();
  assert.equal(h.controller.getPhase(), 'monitoring');
  assert.equal(h.controller.state().idleSince, null);
});

test('checks inspect processes only while armed, or when the user asks', async () => {
  const h = harness();
  await h.controller.poll(); // disarmed: files only
  h.controller.arm();
  await h.controller.poll(); // armed: thorough
  h.controller.disarm('stop.user');
  await h.controller.poll({ thorough: true }); // "check now" while disarmed
  assert.deepEqual(h.thoroughCalls, [false, true, true]);
});

test('a files-only idle result never starts the idle timer while armed', async () => {
  const h = harness({ idleConfirmMinutes: 0 });
  h.controller.arm();
  h.set('idle');
  await h.controller.poll({ thorough: false }); // e.g. a check started while still disarmed
  assert.equal(h.controller.getPhase(), 'monitoring');
  assert.equal(h.controller.state().idleSince, null);
  await h.controller.poll();
  assert.equal(h.controller.getPhase(), 'countdown');
});

test('a files-only busy result still counts (busy is busy)', async () => {
  const h = harness({ idleConfirmMinutes: 0 });
  await intoCountdown(h);
  h.set('busy');
  await h.controller.poll({ thorough: false });
  assert.equal(h.controller.getPhase(), 'monitoring');
});

test('a real shutdown always gets at least one minute of countdown, even when set to 0', async () => {
  const h = harness({ idleConfirmMinutes: 0, countdownMinutes: 0 });
  await intoCountdown(h);
  assert.equal(h.controller.state().countdownTotalMs, MIN);
  h.advance(30_000);
  h.controller.tick();
  await h.settle();
  assert.equal(h.actions.length, 0);
  h.advance(30_000);
  h.controller.tick();
  await h.settle();
  assert.deepEqual(h.actions, [false]);
});

test('a gap between ticks during the countdown (sleep, clock jump) restarts the confirmation', async () => {
  const h = harness({ idleConfirmMinutes: 0 }, { maxTickGapMs: 5_000 });
  await intoCountdown(h);
  h.advance(1_000);
  h.controller.tick();
  assert.equal(h.controller.getPhase(), 'countdown');
  h.advance(8 * 60 * MIN); // the lid was closed all night; timers fire before the resume event
  h.controller.tick();
  await h.settle();
  assert.equal(h.controller.getPhase(), 'monitoring');
  assert.equal(h.actions.length, 0);
});

test('the final check re-reads the session files right before acting', async () => {
  const h = harness({ idleConfirmMinutes: 0, countdownMinutes: 1 });
  await intoCountdown(h);
  h.advance(MIN);
  h.script('idle', 'busy'); // thorough final check says idle, then a turn starts
  h.controller.tick();
  await h.settle();
  assert.equal(h.actions.length, 0);
  assert.equal(h.controller.getPhase(), 'monitoring');
  assert.deepEqual(h.thoroughCalls.slice(-2), [true, false]);
});

test('a settings file that cannot be saved still applies the change and logs a warning', () => {
  const h = harness({}, { saveFails: true });
  const s = h.controller.updateSettings({ countdownMinutes: 9 });
  assert.equal(s.countdownMinutes, 9);
  assert.equal(h.controller.getSettings().countdownMinutes, 9);
  assert.ok(h.log.some((entry) => entry.level === 'warn' && renderEntry('en', entry).includes('EBUSY')));
});

test('log entries keep their code, so they show in whichever language is selected', () => {
  const h = harness({ idleConfirmMinutes: 10, countdownMinutes: 20, action: 'hibernate' });
  h.controller.arm();
  const armed = h.log.find((entry) => entry.code === 'log.armed');
  assert.ok(armed);
  assert.equal(renderEntry('en', armed), 'Watching: once Claude is idle for 10 min, count down 20 min, then hibernate');
  assert.equal(renderEntry('th', armed), 'เริ่มเฝ้า: เมื่อ Claude ว่างต่อเนื่อง 10 นาที จะนับถอยหลัง 20 นาที แล้วHibernate');
});

test('reset to defaults keeps the chosen language', () => {
  const h = harness();
  h.controller.updateSettings({ language: 'th', countdownMinutes: 9 });
  const s = h.controller.resetSettings();
  assert.equal(s.language, 'th');
  assert.equal(s.countdownMinutes, DEFAULT_SETTINGS.countdownMinutes);
});

test('updateSettings clamps values and ignores invalid ones', () => {
  const h = harness();
  const s = h.controller.updateSettings({ pollIntervalSec: 1, action: 'reboot' as never, countdownMinutes: 7 });
  assert.equal(s.pollIntervalSec, 5);
  assert.equal(s.action, 'shutdown');
  assert.equal(s.countdownMinutes, 7);
});

test('the next check time and the length of the wait are in the state (for the countdown ring)', () => {
  const h = harness();
  h.controller.setNextPollAt(1_030_000, 30_000);
  const s = h.controller.state();
  assert.equal(s.nextPollAt, 1_030_000);
  assert.equal(s.nextPollTotalMs, 30_000);
});

test('with the window closed the app stays in the tray while watching, or always in background mode', () => {
  const background = harness({ runInBackground: true });
  assert.equal(background.controller.keepsRunningWithoutWindow(), true);

  const foreground = harness({ runInBackground: false });
  assert.equal(foreground.controller.keepsRunningWithoutWindow(), false); // not watching: closing quits
  foreground.controller.arm();
  assert.equal(foreground.controller.keepsRunningWithoutWindow(), true); // watching never stops on close
  foreground.controller.cancel();
  assert.equal(foreground.controller.keepsRunningWithoutWindow(), false);
});
