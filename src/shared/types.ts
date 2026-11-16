import type { Language, Message, MessageParams } from './i18n';

export type ActionKind = 'shutdown' | 'hibernate' | 'sleep';

export interface Settings {
  /** How often to check Claude sessions, in seconds. */
  pollIntervalSec: number;
  /** Claude must stay idle this long, without a break, before the countdown starts. */
  idleConfirmMinutes: number;
  /** Countdown length before the action runs. */
  countdownMinutes: number;
  /** Waiting this long for the user's answer (permission prompt, question) counts as finished. 0 turns this off. */
  waitingMinutes: number;
  /** A command Claude started (e.g. a background task) showing no activity this long counts as hung. 0 turns this off. */
  toolStallMinutes: number;
  /** A busy session with no activity for this long counts as finished. 0 turns this off. */
  stalledMinutes: number;
  action: ActionKind;
  /** shutdown /f: close other apps without waiting on unsaved-work prompts. */
  forceCloseApps: boolean;
  /** Log and notify instead of running the action. */
  dryRun: boolean;
  /** Mouse or keyboard input during the countdown disarms the app. */
  cancelOnUserActivity: boolean;
  /** Keep Windows from sleeping while armed. */
  preventSleepWhileArmed: boolean;
  /** CPU use (% of one core) above which a session's helper processes count as working. */
  backgroundCpuPercent: number;
  /** Claude config folder. Empty means CLAUDE_CONFIG_DIR or ~/.claude. */
  claudeDir: string;
  /** Language of the window, tray, notifications and log. */
  language: Language;
  /** Closing the window keeps the app in the tray even when not watching; quit from the tray menu. */
  runInBackground: boolean;
}

export type TranscriptState = 'ended' | 'running' | 'unknown';

export type SessionVerdict =
  /** Status is busy and the session is active. */
  | 'working'
  /** A shell Claude started (including a background task) is still running. */
  | 'tool'
  /** Subagent files are being written, or helper processes are using CPU. */
  | 'background'
  /** Waiting on the user (permission prompt or question). */
  | 'waiting'
  /** Turn over, but Claude scheduled itself to continue later (ScheduleWakeup). */
  | 'scheduled'
  /** Stuck (unanswered prompt, hung command, long silence): counts as finished. */
  | 'stalled'
  /** The turn ended with an API error (usage limit...): Claude will not go on by itself. */
  | 'stopped'
  | 'idle';

export interface SessionInfo {
  pid: number;
  sessionId: string;
  name: string;
  cwd: string;
  entrypoint: string;
  status: string | null;
  waitingFor: string | null;
  verdict: SessionVerdict;
  /** True when this session keeps the machine on. */
  blocksShutdown: boolean;
  reason: Message;
  lastActivityAt: number | null;
  transcriptState: TranscriptState;
  /** Names of running tool processes; empty when processes were not inspected. */
  toolProcesses: string[];
  /** CPU % of helper processes (MCP servers etc.); null when not measured. */
  helperCpuPercent: number | null;
  processesChecked: boolean;
}

export type Aggregate = 'busy' | 'idle' | 'unknown';

export interface DetectionResult {
  at: number;
  aggregate: Aggregate;
  sessions: SessionInfo[];
  /** Set when detection could not be completed; the aggregate is then not 'idle'. */
  error: Message | null;
  claudeDir: string;
  usedProcessSnapshot: boolean;
  /** Processes were not inspected (display-only check): an 'idle' aggregate is unverified. */
  partial?: boolean;
  durationMs: number;
}

export type Phase = 'disarmed' | 'monitoring' | 'countdown' | 'executing';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  at: number;
  level: LogLevel;
  /** Message code, shown in the selected language. Missing on entries saved by older versions. */
  code?: string;
  params?: MessageParams;
  /** Plain text of entries saved by older versions (they have no code). */
  message?: string;
}

export interface AppState {
  phase: Phase;
  armedAt: number | null;
  idleSince: number | null;
  countdownEndsAt: number | null;
  /** Length of the running countdown (a real shutdown gets at least a minute). */
  countdownTotalMs: number | null;
  lastDetection: DetectionResult | null;
  /** When the next check runs; in the past while a check is running. */
  nextPollAt: number | null;
  /** Length of the wait for that check, for the countdown ring. */
  nextPollTotalMs: number | null;
  settings: Settings;
  effectiveDryRun: boolean;
  dryRunForced: boolean;
  actionCommand: string;
  defaultClaudeDir: string;
  log: LogEntry[];
}
