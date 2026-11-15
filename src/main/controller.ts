import { ACTION_LABEL, DEFAULT_SETTINGS, formatMinutes, sanitizeSettings } from '../shared/settings';
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
  notify(title: string, body: string): void;
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
    this.addLog(
      'info',
      `เริ่มเฝ้า: เมื่อ Claude ว่างต่อเนื่อง ${formatMinutes(s.idleConfirmMinutes)} จะนับถอยหลัง ${formatMinutes(s.countdownMinutes)} แล้ว${ACTION_LABEL[s.action]}${this.effectiveDryRun ? ' (โหมดทดสอบ)' : ''}`,
    );
    this.deps.onChange();
  }

  disarm(reason: string, level: LogLevel = 'info'): void {
    if (this.phase === 'disarmed') return;
    this.phase = 'disarmed';
    this.armedAt = null;
    this.idleSince = null;
    this.countdownStartedAt = null;
    this.countdownEndsAt = null;
    this.countdownTotalMs = null;
    this.executingSince = null;
    this.deps.setPreventSleep(false);
    this.addLog(level, `หยุดเฝ้า: ${reason}`);
    this.deps.onChange();
  }

  /** The user pressed cancel (countdown) or stop (monitoring). */
  cancel(): void {
    this.disarm(this.phase === 'countdown' || this.phase === 'executing' ? 'ผู้ใช้กดยกเลิกการปิดเครื่อง' : 'ผู้ใช้กดหยุดเฝ้า');
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
        this.disarm('สั่งไปแล้วแต่เครื่องยังทำงานอยู่หลัง 5 นาที', 'warn');
      }
      return;
    }
    if (this.phase !== 'countdown' || this.countdownStartedAt === null || this.countdownEndsAt === null) return;

    // After sleep the timers can fire before the resume event (or never get it), and the clock
    // can jump: never let the countdown finish on time that nobody was watching.
    if (previousTick !== null && now - previousTick > (this.deps.maxTickGapMs ?? DEFAULT_MAX_TICK_GAP_MS)) {
      this.backToMonitoring('เครื่องเพิ่งตื่นหรือเวลาเครื่องเปลี่ยนระหว่างนับถอยหลัง จึงเริ่มยืนยันใหม่');
      this.deps.onChange();
      return;
    }

    if (this.settings.cancelOnUserActivity) {
      const elapsedSec = (now - this.countdownStartedAt) / 1000;
      if (this.deps.systemIdleSeconds() + USER_ACTIVITY_GRACE_SEC < elapsedSec) {
        this.disarm('มีการใช้เมาส์หรือคีย์บอร์ดระหว่างนับถอยหลัง', 'warn');
        this.deps.notify('ยกเลิกการปิดเครื่องแล้ว', 'ตรวจพบว่ามีคนใช้เครื่องอยู่ จึงหยุดเฝ้า');
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
      this.disarm('เครื่องตื่นจาก Sleep/Hibernate');
      return;
    }
    if (this.phase === 'countdown') {
      this.backToMonitoring('เครื่องเพิ่งตื่นระหว่างนับถอยหลัง จึงเริ่มยืนยันใหม่');
    } else if (this.phase === 'monitoring' && this.idleSince !== null) {
      this.idleSince = null;
      this.addLog('info', 'เครื่องเพิ่งตื่น จึงเริ่มจับเวลายืนยันใหม่');
    }
    this.deps.onChange();
  }

  updateSettings(patch: Partial<Settings>): Settings {
    return this.applySettings(sanitizeSettings({ ...this.settings, ...patch }, this.settings));
  }

  resetSettings(): Settings {
    return this.applySettings({ ...DEFAULT_SETTINGS });
  }

  /** Applies settings in memory and saves them; a failed save is logged, never half-applied. */
  private applySettings(next: Settings): Settings {
    this.settings = next;
    try {
      this.deps.saveSettings(next);
    } catch (error) {
      this.addLog('warn', `บันทึกการตั้งค่าลงไฟล์ไม่สำเร็จ (ใช้ได้จนกว่าจะปิดโปรแกรม): ${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.phase === 'monitoring' || this.phase === 'countdown') this.deps.setPreventSleep(next.preventSleepWhileArmed);
    this.deps.onChange();
    return next;
  }

  /** Shows entries saved by a previous run (they are already persisted). */
  restoreLog(entries: readonly LogEntry[]): void {
    this.log = [...entries.slice(-MAX_LOG), ...this.log].slice(-MAX_LOG);
  }

  addLog(level: LogLevel, message: string): void {
    const entry: LogEntry = { at: this.deps.now(), level, message };
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
          error: error instanceof Error ? error.message : String(error),
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
    if (result.error && result.error !== previousError) this.addLog('warn', `ตรวจสถานะไม่สำเร็จ: ${result.error}`);
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
          this.addLog(
            'info',
            result.sessions.length > 0 ? 'Claude ว่างงานแล้ว เริ่มจับเวลายืนยัน' : 'ไม่พบ session ของ Claude ที่เปิดอยู่ เริ่มจับเวลายืนยัน',
          );
        }
        if (now - this.idleSince >= this.settings.idleConfirmMinutes * 60_000) this.startCountdown(now);
      } else if (this.idleSince !== null) {
        this.idleSince = null;
        this.addLog('info', result.aggregate === 'busy' ? 'Claude กลับมาทำงาน จึงเริ่มจับเวลายืนยันใหม่' : 'ตรวจสถานะไม่ได้ จึงเริ่มจับเวลายืนยันใหม่');
      }
    } else if (this.phase === 'countdown' && result.aggregate === 'busy') {
      this.backToMonitoring('Claude กลับมาทำงานระหว่างนับถอยหลัง จึงยกเลิกการนับ');
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
    const message = `Claude ว่างครบ ${formatMinutes(s.idleConfirmMinutes)} แล้ว จะ${ACTION_LABEL[s.action]}ในอีก ${formatMinutes(totalMs / 60_000)}`;
    this.addLog('warn', message);
    this.deps.notify('เริ่มนับถอยหลังก่อนปิดเครื่อง', message);
    this.deps.onCountdownStarted?.();
  }

  private backToMonitoring(reason: string): void {
    this.phase = 'monitoring';
    this.idleSince = null;
    this.countdownStartedAt = null;
    this.countdownEndsAt = null;
    this.countdownTotalMs = null;
    this.addLog('info', reason);
    this.deps.notify('ยกเลิกการนับถอยหลัง', reason);
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
          this.backToMonitoring('Claude เริ่มทำงานพอดีก่อนปิดเครื่อง จึงยังไม่ปิด');
          return;
        }
        await this.execute();
      } else if (result.aggregate === 'busy') {
        this.backToMonitoring('ตรวจซ้ำรอบสุดท้ายพบว่า Claude ยังทำงานอยู่ จึงยังไม่ปิดเครื่อง');
      } else {
        this.finalCheckFailures++;
        if (this.finalCheckFailures >= FINAL_CHECK_MAX_FAILURES) {
          this.backToMonitoring(`ตรวจสถานะรอบสุดท้ายไม่สำเร็จ ${FINAL_CHECK_MAX_FAILURES} ครั้ง จึงยังไม่ปิดเครื่อง`);
        } else {
          this.countdownEndsAt = this.deps.now() + FINAL_CHECK_RETRY_MS;
          this.addLog('warn', 'ตรวจสถานะรอบสุดท้ายไม่สำเร็จ จะลองใหม่ใน 15 วินาที');
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
      this.addLog('warn', `[โหมดทดสอบ] ถึงเวลาแล้ว คำสั่งที่จะใช้จริงคือ: ${outcome.command}`);
      this.deps.notify('โหมดทดสอบ: ถึงเวลาปิดเครื่องแล้ว', `คำสั่งที่จะใช้จริง: ${outcome.command}`);
      this.disarm('โหมดทดสอบทำงานครบรอบแล้ว');
    } else if (!outcome.ok) {
      this.addLog('error', `สั่ง ${outcome.command} ไม่สำเร็จ: ${outcome.error ?? 'ไม่ทราบสาเหตุ'}`);
      this.deps.notify('สั่งปิดเครื่องไม่สำเร็จ', outcome.error ?? outcome.command);
      this.disarm('สั่งปิดเครื่องไม่สำเร็จ', 'error');
    } else {
      this.addLog('warn', `สั่ง ${outcome.command} แล้ว`);
    }
  }
}
