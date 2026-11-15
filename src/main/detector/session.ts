import { msg, type Message, type MessageParams } from '../../shared/i18n';
import type { SessionVerdict, Settings, TranscriptState } from '../../shared/types';
import type { ProcInfo } from './processes';
import type { PendingTool } from './transcript';

/**
 * `<claudeDir>/sessions/<pid>.json`, written by every running Claude Code process
 * (desktop app sessions and CLI alike). Internal format, observed on Claude Code 2.1.325:
 * {"pid":28348,"sessionId":"…","cwd":"…","procStart":"134391962772404597","status":"busy",
 *  "statusUpdatedAt":1794723027028,"updatedAt":…,"entrypoint":"claude-desktop",…}
 * status is "busy", "idle" or "shell" (turn over, a shell still running). waitingFor is set
 * while one of Claude Code's own dialogs waits ("dialog open", "sandbox request", ...); tool
 * permission prompts in the desktop app are shown by the app and do not set it.
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

/** Tools that always wait for the user (value: what they wait for, a "what.<value>" text). */
const QUESTION_TOOLS: Record<string, string> = { AskUserQuestion: 'question', ExitPlanMode: 'plan' };
/** Tools that start a shell once allowed: no shell after the grace period = permission prompt. */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
/** Tools that finish within seconds once allowed: still pending after the grace period = permission prompt. */
const INSTANT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Grep', 'Glob']);
/** Claude Code's waitingFor values → "what.<value>" texts. */
const WAITING_FOR: Record<string, string> = {
  'dialog open': 'dialog',
  'sandbox request': 'sandbox',
  'goal proposal': 'goal',
};

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

const waitingForWhat = (value: string): MessageParams => (WAITING_FOR[value] ? { what: WAITING_FOR[value] } : { what: 'other', value });

/** Is the session waiting for the user? 'check' = only a process snapshot can tell. */
function detectWaiting(input: EvaluateInput, busy: boolean, latest: number | null, toolsRunning: boolean | null): Waiting {
  const { file, now, processes } = input;
  if (file.waitingFor !== undefined) return { since: latest ?? now, what: waitingForWhat(file.waitingFor) };
  if (!busy) return null;
  let needsCheck = false;
  for (const tool of input.pendingTools) {
    const at = tool.at ?? latest ?? now;
    const question = QUESTION_TOOLS[tool.name];
    if (question) return { since: at, what: { what: question } };
    if (now - at < PERMISSION_GRACE_MS) continue;
    if (INSTANT_TOOLS.has(tool.name)) return { since: at, what: { what: 'permission', tool: tool.name } };
    if (SHELL_TOOLS.has(tool.name)) {
      if (processes === null || toolsRunning === null) {
        needsCheck = true;
        continue;
      }
      // An allowed command starts processes. Anything started since the call (even a shell
      // without a known marker) or any helper activity means it is running, not waiting.
      const newest = processes.newestChildAt ?? null;
      const startedSince = newest !== null && newest >= at - CHILD_TIME_SLACK_MS;
      if (!toolsRunning && !startedSince && processes.helpersActiveNow !== true) return { since: at, what: { what: 'permission', tool: tool.name } };
    }
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
  if (input.runningSubagentAt !== null && (stalledMs <= 0 || now - input.runningSubagentAt < stalledMs)) {
    return result('background', true, msg('reason.subagent'));
  }
  if (input.sideActivityAt !== null && now - input.sideActivityAt < SIDE_ACTIVITY_WINDOW_MS) {
    return result('background', true, msg('reason.sideActivity'));
  }
  // Helper CPU after the turn (headless browser, busy MCP server...) counts only for a while.
  const turnOverForMs = now - (file.statusUpdatedAt ?? latest ?? now);
  if (helperBusy && (toolStallMs <= 0 || turnOverForMs < toolStallMs)) {
    return result('background', true, msg('reason.helperCpu', { cpu: processes!.helperCpuPercent!.toFixed(1) }));
  }
  if (hung.length > 0) {
    const idleMs = now - (processes!.toolsActiveAt ?? now);
    return result('stalled', false, msg('reason.toolHung', { ms: idleMs, names: toolNames(hung) }));
  }
  if (shellHungMs !== null) return result('stalled', false, msg('reason.shellHung', { ms: shellHungMs }));
  return result('idle', false, msg(processes ? 'reason.idle' : 'reason.idleUnchecked'));
}
