export type ActionKind = 'shutdown' | 'hibernate' | 'sleep';

export interface Settings {
  /** How often to check Claude sessions, in seconds. */
  pollIntervalSec: number;
  /** Claude must stay idle this long, without a break, before the countdown starts. */
  idleConfirmMinutes: number;
  /** Countdown length before the action runs. */
  countdownMinutes: number;
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
  /** Busy, but nothing has happened for stalledMinutes: counts as finished. */
  | 'stalled'
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
  reason: string;
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
  error: string | null;
  claudeDir: string;
  usedProcessSnapshot: boolean;
  durationMs: number;
}

export type Phase = 'disarmed' | 'monitoring' | 'countdown' | 'executing';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  at: number;
  level: LogLevel;
  message: string;
}

export interface AppState {
  phase: Phase;
  armedAt: number | null;
  idleSince: number | null;
  countdownEndsAt: number | null;
  lastDetection: DetectionResult | null;
  nextPollAt: number | null;
  settings: Settings;
  effectiveDryRun: boolean;
  dryRunForced: boolean;
  actionCommand: string;
  defaultClaudeDir: string;
  log: LogEntry[];
}
