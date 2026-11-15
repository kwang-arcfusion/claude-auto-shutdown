import { msg, type Message, type MessageCode, type MessageParams } from '../shared/i18n';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../shared/settings';
import type { AppState, DetectionResult, LogEntry, LogLevel, Phase, Settings } from '../shared/types';

export interface ActionResult {
  ok: boolean;
  command: string;
  error?: string;
}

export interface ControllerDeps {
  now(): number;
  /** thorough = inspect processes when needed; false = files only (display while disarmed). */
  detect(settings: Settings, thorough: boolean): Promise<DetectionResult>;
  runAction(settings: Settings, dryRun: boolean): Promise<ActionResult>;
  describeAction(settings: Settings): string;
  /** Seconds since the last mouse or keyboard input (Electron powerMonitor). */
  systemIdleSeconds(): number;
  setPreventSleep(on: boolean): void;
  /** Shown in the language selected when the notification goes out. */
  notify(title: Message, body: Message): void;
  saveSettings(settings: Settings): void;
  persistLog(entry: LogEntry): void;
  onChange(): void;
  onCountdownStarted?(): void;
  defaultClaudeDir: string;
  /** A gap between ticks longer than this during the countdown means sleep or a clock jump. */
  maxTickGapMs?: number;
}

const MAX_LOG = 200;
const FINAL_CHECK_RETRY_MS = 15_000;
const FINAL_CHECK_MAX_FAILURES = 3;
/** Input within this many seconds of the countdown starting is ignored. */
const USER_ACTIVITY_GRACE_SEC = 2;
const EXECUTING_WATCHDOG_MS = 5 * 60_000;
/** A real shutdown always gets at least this much countdown, whatever the settings say. */
const MIN_REAL_COUNTDOWN_MS = 60_000;
const DEFAULT_MAX_TICK_GAP_MS = 5_000;

const sameMessage = (a: Message | null, b: Message | null): boolean =>
  a === b || (a !== null && b !== null && a.code === b.code && JSON.stringify(a.params ?? {}) === JSON.stringify(b.params ?? {}));

/**
 * The arm → monitor → countdown → act state machine. It owns no timers: the host
 * calls poll() every poll interval and tick() every second.
 */
export class Controller {
  private phase: Phase = 'disarmed';
  private armedAt: number | null = null;
  private idleSince: number | null = null;
  private countdownStartedAt: number | null = null;
  private countdownEndsAt: number | null = null;
  private countdownTotalMs: number | null = null;
  private lastTickAt: number | null = null;
  private executingSince: number | null = null;
  private lastDetection: DetectionResult | null = null;
  private nextPollAt: number | null = null;
  private log: LogEntry[] = [];
  private inFlight: { promise: Promise<DetectionResult>; thorough: boolean } | null = null;
  private finalCheckRunning: Promise<void> | null = null;
  private finalCheckFailures = 0;

  constructor(
    private readonly deps: ControllerDeps,
    private settings: Settings,
    private readonly dryRunForced = false,
  ) {}

  getPhase(): Phase {
    return this.phase;
  }

  getSettings(): Settings {
    return this.settings;
  }

  get effectiveDryRun(): boolean {
    return this.dryRunForced || this.settings.dryRun;
  }

  setNextPollAt(at: number | null): void {
    this.nextPollAt = at;
  }

  state(): AppState {
    return {
      phase: this.phase,
      armedAt: this.armedAt,
      idleSince: this.idleSince,
      countdownEndsAt: this.countdownEndsAt,
      countdownTotalMs: this.countdownTotalMs,
      lastDetection: this.lastDetection,
      nextPollAt: this.nextPollAt,
      settings: this.settings,
      effectiveDryRun: this.effectiveDryRun,
      dryRunForced: this.dryRunForced,
      actionCommand: this.deps.describeAction(this.settings),
      defaultClaudeDir: this.deps.defaultClaudeDir,
      log: this.log.slice(-100).reverse(),
    };
  }

  arm(): void {
    if (this.phase !== 'disarmed') return;
    this.phase = 'monitoring';
    this.armedAt = this.deps.now();
    this.idleSince = null;
    this.finalCheckFailures = 0;
    this.deps.setPreventSleep(this.settings.preventSleepWhileArmed);
    const s = this.settings;
    this.addLog('info', this.effectiveDryRun ? 'log.armedDryRun' : 'log.armed', {
      idle: s.idleConfirmMinutes,
      countdown: s.countdownMinutes,
      action: s.action,
    });
    this.deps.onChange();
  }

  disarm(reason: MessageCode, level: LogLevel = 'info'): void {
    if (this.phase === 'disarmed') return;
    this.phase = 'disarmed';
    this.armedAt = null;
    this.idleSince = null;
    this.countdownStartedAt = null;
    this.countdownEndsAt = null;
    this.countdownTotalMs = null;
    this.executingSince = null;
    this.deps.setPreventSleep(false);
    this.addLog(level, reason);
    this.deps.onChange();
  }

  /** The user pressed cancel (countdown) or stop (monitoring). */
  cancel(): void {
    this.disarm(this.phase === 'countdown' || this.phase === 'executing' ? 'stop.userCancel' : 'stop.user');
  }

  /** Checks once. Thorough by default while armed; `thorough: true` forces it (user asked). */
  async poll(options: { thorough?: boolean } = {}): Promise<DetectionResult> {
    const result = await this.detect(options.thorough ?? this.phase !== 'disarmed');
    this.handleDetection(result);
    this.deps.onChange();
    return result;
  }

  /** Called every second: countdown deadline, user activity and the executing watchdog. */
  tick(): void {
    const now = this.deps.now();
    const previousTick = this.lastTickAt;
    this.lastTickAt = now;
    if (this.phase === 'executing') {
      if (this.executingSince !== null && now - this.executingSince > EXECUTING_WATCHDOG_MS) {
        this.disarm('stop.watchdog', 'warn');
      }
      return;
    }
    if (this.phase !== 'countdown' || this.countdownStartedAt === null || this.countdownEndsAt === null) return;

    // After sleep the timers can fire before the resume event (or never get it), and the clock
    // can jump: never let the countdown finish on time that nobody was watching.
    if (previousTick !== null && now - previousTick > (this.deps.maxTickGapMs ?? DEFAULT_MAX_TICK_GAP_MS)) {
      this.backToMonitoring('log.tickGap');
      this.deps.onChange();
      return;
    }

    if (this.settings.cancelOnUserActivity) {
      const elapsedSec = (now - this.countdownStartedAt) / 1000;
      if (this.deps.systemIdleSeconds() + USER_ACTIVITY_GRACE_SEC < elapsedSec) {
        this.disarm('stop.userActivity', 'warn');
        this.deps.notify(msg('notify.cancelled.title'), msg('notify.userActivity.body'));
        return;
      }
    }
    if (now >= this.countdownEndsAt && !this.finalCheckRunning) {
      this.finalCheckRunning = this.finalCheck().finally(() => {
        this.finalCheckRunning = null;
      });
    }
  }

  /** Resolves once a final check started by tick() (if any) has finished. */
  settled(): Promise<void> {
    return this.finalCheckRunning ?? Promise.resolve();
  }

  /** The machine woke from sleep or hibernation. */
  onResume(): void {
    if (this.phase === 'executing') {
      this.disarm('stop.resumed');
      return;
    }
    if (this.phase === 'countdown') {
      this.backToMonitoring('log.resumedDuringCountdown');
    } else if (this.phase === 'monitoring' && this.idleSince !== null) {
      this.idleSince = null;
      this.addLog('info', 'log.resumedConfirmReset');
    }
    this.deps.onChange();
  }

  updateSettings(patch: Partial<Settings>): Settings {
    return this.applySettings(sanitizeSettings({ ...this.settings, ...patch }, this.settings));
  }

  /** Back to the default timers and options; the language stays as chosen. */
  resetSettings(): Settings {
    return this.applySettings({ ...DEFAULT_SETTINGS, language: this.settings.language });
  }

  /** Applies settings in memory and saves them; a failed save is logged, never half-applied. */
  private applySettings(next: Settings): Settings {
    this.settings = next;
    try {
      this.deps.saveSettings(next);
    } catch (error) {
      this.addLog('warn', 'log.settingsSaveFailed', { detail: error instanceof Error ? error.message : String(error) });
    }
    if (this.phase === 'monitoring' || this.phase === 'countdown') this.deps.setPreventSleep(next.preventSleepWhileArmed);
    this.deps.onChange();
    return next;
  }

  /** Shows entries saved by a previous run (they are already persisted). */
  restoreLog(entries: readonly LogEntry[]): void {
    this.log = [...entries.slice(-MAX_LOG), ...this.log].slice(-MAX_LOG);
  }

  addLog(level: LogLevel, code: MessageCode, params?: MessageParams): void {
    const entry: LogEntry = params ? { at: this.deps.now(), level, code, params } : { at: this.deps.now(), level, code };
    this.log.push(entry);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    this.deps.persistLog(entry);
  }

  /**
   * One detection at a time; the poll loop and the final check share it. A thorough request
   * never reuses a files-only check, and a fresh one never reuses anything: they wait for the
   * running check to finish and then run their own.
   */
  private detect(thorough: boolean, fresh = false): Promise<DetectionResult> {
    const current = this.inFlight;
    if (!fresh && current && (current.thorough || !thorough)) return current.promise;
    const run = async (): Promise<DetectionResult> => {
      if (current) await current.promise; // never rejects
      try {
        return await this.deps.detect(this.settings, thorough);
      } catch (error) {
        return {
          at: this.deps.now(),
          aggregate: 'unknown',
          sessions: [],
          error: msg('app.checkFailed', { detail: error instanceof Error ? error.message : String(error) }),
          claudeDir: '',
          usedProcessSnapshot: false,
          durationMs: 0,
        };
      }
    };
    const promise = run().finally(() => {
      if (this.inFlight?.promise === promise) this.inFlight = null;
    });
    this.inFlight = { promise, thorough };
    return promise;
  }

  private recordDetection(result: DetectionResult): void {
    const previousError = this.lastDetection?.error ?? null;
    this.lastDetection = result;
    if (result.error && !sameMessage(result.error, previousError)) this.addLog('warn', result.error.code, result.error.params);
  }

  private handleDetection(result: DetectionResult): void {
    this.recordDetection(result);
    // A files-only result cannot prove Claude is idle (background commands were not checked),
    // e.g. one started while disarmed and finished just after arming. It only counts when busy.
    if (result.partial && result.aggregate !== 'busy' && this.phase !== 'disarmed') return;
    const now = this.deps.now();
    if (this.phase === 'monitoring') {
      if (result.aggregate === 'idle') {
        if (this.idleSince === null) {
          this.idleSince = now;
          this.addLog('info', result.sessions.length > 0 ? 'log.idleStarted' : 'log.noSessions');
        }
        if (now - this.idleSince >= this.settings.idleConfirmMinutes * 60_000) this.startCountdown(now);
      } else if (this.idleSince !== null) {
        this.idleSince = null;
        this.addLog('info', result.aggregate === 'busy' ? 'log.busyAgain' : 'log.unknownReset');
      }
    } else if (this.phase === 'countdown' && result.aggregate === 'busy') {
      this.backToMonitoring('log.countdownCancelledBusy');
    }
    // 'unknown' during the countdown keeps counting: the final check before acting must still pass.
  }

  private startCountdown(now: number): void {
    const s = this.settings;
    // Always leave a real shutdown a minute in which it can still be cancelled.
    const totalMs = this.effectiveDryRun ? s.countdownMinutes * 60_000 : Math.max(s.countdownMinutes * 60_000, MIN_REAL_COUNTDOWN_MS);
    this.phase = 'countdown';
    this.countdownStartedAt = now;
    this.countdownEndsAt = now + totalMs;
    this.countdownTotalMs = totalMs;
    this.lastTickAt = now;
    this.finalCheckFailures = 0;
    const message = msg('log.countdownStarted', { idle: s.idleConfirmMinutes, countdown: totalMs / 60_000, action: s.action });
    this.addLog('warn', message.code, message.params);
    this.deps.notify(msg('notify.countdown.title'), message);
    this.deps.onCountdownStarted?.();
  }

  private backToMonitoring(reason: MessageCode, params?: MessageParams): void {
    this.phase = 'monitoring';
    this.idleSince = null;
    this.countdownStartedAt = null;
    this.countdownEndsAt = null;
    this.countdownTotalMs = null;
    this.addLog('info', reason, params);
    this.deps.notify(msg('notify.countdownCancelled.title'), msg(reason, params));
  }

  private async finalCheck(): Promise<void> {
    try {
      // A fresh, thorough check: never a result that was started earlier.
      const result = await this.detect(true, true);
      this.recordDetection(result);
      if (this.phase !== 'countdown') return; // cancelled while checking
      if (result.aggregate === 'idle') {
        // One last cheap look at the session files right before acting: a turn may have
        // started during the seconds the process snapshot took.
        const latest = await this.detect(false, true);
        if (this.phase !== 'countdown') return;
        if (latest.aggregate === 'busy') {
          this.recordDetection(latest);
          this.backToMonitoring('log.lastMomentBusy');
          return;
        }
        await this.execute();
      } else if (result.aggregate === 'busy') {
        this.backToMonitoring('log.finalCheckBusy');
      } else {
        this.finalCheckFailures++;
        if (this.finalCheckFailures >= FINAL_CHECK_MAX_FAILURES) {
          this.backToMonitoring('log.finalCheckFailedTooOften', { count: FINAL_CHECK_MAX_FAILURES });
        } else {
          this.countdownEndsAt = this.deps.now() + FINAL_CHECK_RETRY_MS;
          this.addLog('warn', 'log.finalCheckRetry');
        }
      }
    } finally {
      this.deps.onChange();
    }
  }

  private async execute(): Promise<void> {
    const dryRun = this.effectiveDryRun;
    const settings = this.settings;
    this.phase = 'executing';
    this.executingSince = this.deps.now();
    // Release our own sleep blocker so it cannot get in the way of the action.
    this.deps.setPreventSleep(false);
    this.deps.onChange();

    let outcome: ActionResult;
    try {
      outcome = await this.deps.runAction(settings, dryRun);
    } catch (error) {
      outcome = { ok: false, command: this.deps.describeAction(settings), error: error instanceof Error ? error.message : String(error) };
    }
    if (this.phase !== 'executing') return; // cancelled, or the machine already slept and woke up

    if (dryRun) {
      this.addLog('warn', 'log.dryRunAction', { command: outcome.command });
      this.deps.notify(msg('notify.dryRun.title'), msg('notify.dryRun.body', { command: outcome.command }));
      this.disarm('stop.dryRunDone');
    } else if (!outcome.ok) {
      this.addLog('error', 'log.actionFailed', { command: outcome.command, detail: outcome.error ?? '?' });
      this.deps.notify(msg('notify.actionFailed.title'), msg('notify.actionFailed.body', { detail: outcome.error ?? outcome.command }));
      this.disarm('stop.actionFailed', 'error');
    } else {
      this.addLog('warn', 'log.actionSent', { command: outcome.command });
    }
  }
}
