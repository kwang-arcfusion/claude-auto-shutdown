import { msg, type Message, type MessageParams } from '../../shared/i18n';
import type { SessionVerdict, Settings, TranscriptState } from '../../shared/types';
import type { ProcInfo } from './processes';
import type { PendingTool, TimedWait } from './transcript';

/**
 * `<claudeDir>/sessions/<pid>.json`, written by every running Claude Code process
 * (desktop app sessions and CLI alike). Internal format, observed on Claude Code 2.1.325:
 * {"pid":28348,"sessionId":"…","cwd":"…","procStart":"134391962772404597","status":"busy",
 *  "statusUpdatedAt":1794723027028,"updatedAt":…,"entrypoint":"claude-desktop",…}
 * status is "busy", "idle", "shell" (turn over, a background shell still running; terminal
 * only) or "waiting" (a permission prompt, question, dialog or MCP input request is open), with
 * waitingFor saying which: "permission prompt", "input needed", "dialog open", ...
 * The file is written only when these change (no heartbeat): a session can stay "busy" for
 * hours while background agents or workflows run.
 */
export interface SessionFile {
  pid: number;
  sessionId: string;
  cwd?: string;
  name?: string;
  status?: string;
  waitingFor?: string;
  procStart?: string;
  startedAt?: number;
  updatedAt?: number;
  statusUpdatedAt?: number;
  entrypoint?: string;
  kind?: string;
  /** Claude Code version that wrote the file, e.g. "2.1.325". */
  version?: string;
}

export function parseSessionFile(text: string): SessionFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const pid = Number(r.pid);
  const sessionId = typeof r.sessionId === 'string' ? r.sessionId : '';
  if (!Number.isInteger(pid) || pid <= 0 || !sessionId) return null;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    pid,
    sessionId,
    cwd: str(r.cwd),
    name: str(r.name),
    status: str(r.status),
    waitingFor: str(r.waitingFor),
    procStart: str(r.procStart) ?? (typeof r.procStart === 'number' ? String(r.procStart) : undefined),
    startedAt: num(r.startedAt),
    updatedAt: num(r.updatedAt),
    statusUpdatedAt: num(r.statusUpdatedAt),
    entrypoint: str(r.entrypoint),
    kind: str(r.kind),
    version: str(r.version),
  };
}

export interface SessionActivity {
  transcriptState: TranscriptState;
  /** Latest of the transcript's modification time and the session file's timestamps. */
  lastActivityAt: number | null;
  /** Latest write in the session's side folder (subagent transcripts and the like). */
  sideActivityAt: number | null;
  /** Tool calls of the current turn that have no result yet. */
  pendingTools: PendingTool[];
  /** When a ScheduleWakeup call will wake the session (ms). */
  scheduledWakeAt: number | null;
  /** Latest write of a subagent transcript that is still mid-turn (ms). */
  runningSubagentAt: number | null;
  /** The next run of a CronCreate job (fixed-interval /loop, reminder) that keeps the PC on (ms). */
  cronNextAt?: number | null;
  /** ...until this time: the run may start late (jitter), so a grace period is added (ms). */
  cronUntil?: number | null;
  /** Commands that wait on purpose (Start-Sleep 600, a polling loop, gh run watch...). */
  waits?: TimedWait[];
  /** The last turn ended with an API error (usage limit...): its text. */
  stoppedByError?: string | null;
}

export interface ProcessFacts {
  tools: ProcInfo[];
  /** Total CPU % of helper processes; null when it could not be measured. */
  helperCpuPercent: number | null;
  /** When the tool processes last showed any activity (CPU, I/O, output, process changes, timed sleep). */
  toolsActiveAt: number | null;
  /** Newest creation time (ms) among all of the session's descendants. */
  newestChildAt?: number | null;
  /** Helper processes used CPU or I/O since the previous check (true when unknown). */
  helpersActiveNow?: boolean;
  /** Status "shell" with no recognised tool: when any descendant last showed activity. */
  shellActiveAt?: number | null;
}

export interface EvaluateInput extends SessionActivity {
  file: SessionFile;
  /** null when no process snapshot was taken for this check. */
  processes: ProcessFacts | null;
  now: number;
  settings: Settings;
}

export interface Evaluation {
  verdict: SessionVerdict;
  blocksShutdown: boolean;
  reason: Message;
  /** The verdict can only be settled with a process snapshot. */
  needsProcessCheck: boolean;
}

const MIN = 60_000;
/** An idle session whose side folder was written this recently still counts as working. */
export const SIDE_ACTIVITY_WINDOW_MS = 2 * MIN;
/** How long an allowed tool may take to start before its pending call means a permission prompt. */
export const PERMISSION_GRACE_MS = MIN;
/** A scheduled wake-up keeps the session busy until this long after it is due. */
export const WAKE_GRACE_MS = 5 * MIN;
/** Process creation times and transcript timestamps come from different clocks. */
const CHILD_TIME_SLACK_MS = 2_000;
/** Helper CPU can stretch the silence rule of a busy turn, but only this far. */
export const HELPER_EXTENSION_MAX_MS = 3 * 60 * MIN;
/** Helper CPU after the turn keeps the PC on this long when toolStallMinutes is 0 (off). */
const HELPER_AFTER_TURN_DEFAULT_MS = 20 * MIN;

/**
 * The statuses Claude Code writes (verified in the 2.1.325 binary: ["busy","shell","idle","waiting"]).
 * "waiting" = a permission prompt, a question, a dialog or an MCP input request is open.
 * Anything else means its format changed.
 */
export const KNOWN_STATUSES: ReadonlySet<string> = new Set(['busy', 'idle', 'shell', 'waiting']);
/**
 * From this version on, Claude Code reports its own state: prompts as status "waiting", and
 * delegated work (background agents, workflows, teammates) by staying "busy". So prompts are not
 * guessed, and a subagent transcript left mid-turn after the session went idle is a leftover
 * (cut off by a usage limit, say), not work.
 */
const REPORTS_OWN_STATE_FROM = '2.1.325';

/** Tools that always wait for the user (value: what they wait for, a "what.<value>" text). */
const QUESTION_TOOLS: Record<string, string> = { AskUserQuestion: 'question', ExitPlanMode: 'plan' };
/** Tools that start a shell once allowed: no shell after the grace period = permission prompt. */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
/** Tools that finish within seconds once allowed: still pending after the grace period = permission prompt. */
const INSTANT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Grep', 'Glob']);
/** Claude Code's waitingFor values → "what.<value>" texts ("permission prompt" is handled apart). */
const WAITING_FOR: Record<string, string> = {
  'input needed': 'input',
  'dialog open': 'dialog',
  'sandbox request': 'sandbox',
  'goal proposal': 'goal',
  'worker request': 'worker',
};

/** -1, 0 or 1 for dotted version numbers ("2.1.325"); null when either cannot be read. */
export function compareVersions(a: string | undefined, b: string): number | null {
  if (!a) return null;
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  if (pa.some((n) => !Number.isFinite(n))) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function maxOf(...values: Array<number | null | undefined>): number | null {
  let max: number | null = null;
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && (max === null || v > max)) max = v;
  }
  return max;
}

const toolNames = (tools: readonly ProcInfo[]): string => [...new Set(tools.map((p) => p.name))].join(', ');

const result = (verdict: SessionVerdict, blocksShutdown: boolean, reason: Message, needsProcessCheck = false): Evaluation => ({
  verdict,
  blocksShutdown,
  reason,
  needsProcessCheck,
});

/** `what` holds the params of a "what.<value>" text: {what: 'permission', tool: 'Bash'}. */
type Waiting = { since: number; what: MessageParams } | 'check' | null;

function waitingForWhat(value: string | undefined, pending: readonly PendingTool[]): MessageParams {
  if (value === undefined) return { what: 'input' };
  if (value === 'permission prompt') {
    const tool = pending.at(-1)?.name;
    return tool ? { what: 'permission', tool } : { what: 'permissionAny' };
  }
  return WAITING_FOR[value] ? { what: WAITING_FOR[value] } : { what: 'other', value };
}

/** Is the session waiting for the user? 'check' = only a process snapshot can tell. */
function detectWaiting(input: EvaluateInput, busy: boolean, latest: number | null, toolsRunning: boolean | null): Waiting {
  const { file, now, processes } = input;
  // Claude Code says so itself (status "waiting"); statusUpdatedAt is written when it starts.
  if (file.status === 'waiting' || file.waitingFor !== undefined) {
    return { since: file.statusUpdatedAt ?? latest ?? now, what: waitingForWhat(file.waitingFor, input.pendingTools) };
  }
  if (!busy) return null;
  // A version that reports prompts itself is not waiting while it says "busy": a slow tool is
  // just slow. Older versions only show a prompt as a tool call that does not start.
  if ((compareVersions(file.version, REPORTS_OWN_STATE_FROM) ?? -1) >= 0) return null;
  let needsCheck = false;
  for (const tool of input.pendingTools) {
    const at = tool.at ?? latest ?? now;
    const question = QUESTION_TOOLS[tool.name];
    if (question) return { since: at, what: { what: question } };
    if (now - at < PERMISSION_GRACE_MS) continue;
    if (!INSTANT_TOOLS.has(tool.name) && !SHELL_TOOLS.has(tool.name)) continue;
    if (processes === null || toolsRunning === null) {
      needsCheck = true;
      continue;
    }
    // An allowed tool shows up as processes: a shell, ripgrep, a hook it triggers. Anything
    // started since the call, or any helper activity, means it is running, not waiting.
    const newest = processes.newestChildAt ?? null;
    const startedSince = newest !== null && newest >= at - CHILD_TIME_SLACK_MS;
    if (!toolsRunning && !startedSince && processes.helpersActiveNow !== true) return { since: at, what: { what: 'permission', tool: tool.name } };
  }
  return needsCheck ? 'check' : null;
}

export function evaluateSession(input: EvaluateInput): Evaluation {
  const { file, processes, now, settings } = input;
  const latest = maxOf(input.lastActivityAt, input.sideActivityAt);
  const quietMs = latest === null ? Number.POSITIVE_INFINITY : now - latest;
  // Without a status field, fall back to the transcript; an unreadable transcript counts as busy.
  const busy = file.status !== undefined ? file.status === 'busy' : input.transcriptState !== 'ended';

  const toolStallMs = settings.toolStallMinutes * MIN;
  const stalledMs = settings.stalledMinutes * MIN;

  // 0. A status this app does not know (Claude Code updated?) never counts as finished. After a
  // long silence, a process check still drops a file left behind by a process that has exited.
  if (file.status !== undefined && !KNOWN_STATUSES.has(file.status)) {
    const needsCheck = processes === null && stalledMs > 0 && quietMs >= stalledMs;
    return result('working', true, msg('reason.unknownStatus', { status: file.status }), needsCheck);
  }

  // 1. Commands Claude started, including background tasks: wait while they show any activity.
  let hung: ProcInfo[] = [];
  if (processes && processes.tools.length > 0) {
    const idleMs = now - (processes.toolsActiveAt ?? now);
    if (toolStallMs <= 0 || idleMs < toolStallMs) return result('tool', true, msg('reason.tool', { names: toolNames(processes.tools) }));
    hung = processes.tools; // no CPU, I/O, output or process changes for too long
  }

  // 1b. Claude Code itself says a shell is still running ("shell"), but none carries a known
  // marker (another shell, unreadable command lines...): judge by the activity of everything
  // under the session; with nothing to measure, fall back to the long-silence rule.
  let shellHungMs: number | null = null;
  if (file.status === 'shell' && (processes === null || processes.tools.length === 0)) {
    const reason = msg('reason.shellRunning');
    if (processes === null) return result('tool', true, reason, true);
    const activeAt = processes.shellActiveAt ?? null;
    if (activeAt !== null) {
      if (toolStallMs <= 0 || now - activeAt < toolStallMs) return result('tool', true, reason);
      shellHungMs = now - activeAt;
    } else {
      if (stalledMs <= 0 || quietMs < stalledMs) return result('tool', true, reason);
      shellHungMs = quietMs;
    }
  }
  const toolsRunning = processes === null ? null : processes.tools.length > 0 && hung.length === 0;

  // 2. Waiting for the user (permission prompt, question, dialog): finished after waitingMinutes.
  const waiting = detectWaiting(input, busy, latest, toolsRunning);
  if (waiting === 'check') return result('working', true, msg('reason.checkingPermission'), true);
  const waitMs = settings.waitingMinutes * MIN;
  if (waiting && waitMs > 0) {
    return now - waiting.since >= waitMs
      ? result('stalled', false, msg('reason.waitedTooLong', { ...waiting.what, ms: waitMs }))
      : result('waiting', true, msg('reason.waiting', waiting.what));
  }

  const helperBusy =
    processes !== null && processes.helperCpuPercent !== null && processes.helperCpuPercent >= settings.backgroundCpuPercent;

  // 3. A turn in progress: finished only after a long silence. Helper CPU (an MCP call, say)
  // can stretch that, but not forever: a spinning helper must not keep the PC on all night.
  if (busy || waiting) {
    if (stalledMs > 0 && quietMs >= stalledMs) {
      if (processes === null) {
        return result(waiting ? 'waiting' : 'working', true, msg('reason.quietChecking', { ms: quietMs }), true);
      }
      if (!helperBusy || quietMs >= HELPER_EXTENSION_MAX_MS) {
        return result('stalled', false, msg('reason.quietFinished', { ms: quietMs }));
      }
    }
    if (waiting) return result('waiting', true, msg('reason.waiting', waiting.what));
    return result('working', true, msg(file.status !== undefined ? 'reason.working' : 'reason.workingNoStatus'));
  }

  // 4. Turn over: is anything still going on in the background?
  if (input.scheduledWakeAt !== null && now < input.scheduledWakeAt + WAKE_GRACE_MS) {
    return result('scheduled', true, msg('reason.scheduled', { at: input.scheduledWakeAt }));
  }
  if (input.cronNextAt != null && input.cronUntil != null && now < input.cronUntil) {
    return result('scheduled', true, msg('reason.scheduled', { at: input.cronNextAt }));
  }
  // The turn ended with an API error (usage limit, overload...): Claude stops there until someone
  // acts, so guesses about background work (subagent leftovers, helper CPU) no longer matter.
  if (input.stoppedByError) return result('stopped', false, msg('reason.stoppedByError', { detail: input.stoppedByError }));
  const reportsOwnState = (compareVersions(file.version, REPORTS_OWN_STATE_FROM) ?? -1) >= 0;
  if (!reportsOwnState && input.runningSubagentAt !== null && (stalledMs <= 0 || now - input.runningSubagentAt < stalledMs)) {
    return result('background', true, msg('reason.subagent'));
  }
  if (input.sideActivityAt !== null && now - input.sideActivityAt < SIDE_ACTIVITY_WINDOW_MS) {
    return result('background', true, msg('reason.sideActivity'));
  }
  // Helper CPU after the turn (headless browser, busy MCP server...) counts only for a while.
  const turnOverForMs = now - (file.statusUpdatedAt ?? latest ?? now);
  if (helperBusy && turnOverForMs < (toolStallMs > 0 ? toolStallMs : HELPER_AFTER_TURN_DEFAULT_MS)) {
    return result('background', true, msg('reason.helperCpu', { cpu: processes!.helperCpuPercent!.toFixed(1) }));
  }
  if (hung.length > 0) {
    const idleMs = now - (processes!.toolsActiveAt ?? now);
    return result('stalled', false, msg('reason.toolHung', { ms: idleMs, names: toolNames(hung) }));
  }
  if (shellHungMs !== null) return result('stalled', false, msg('reason.shellHung', { ms: shellHungMs }));
  return result('idle', false, msg(processes ? 'reason.idle' : 'reason.idleUnchecked'));
}
