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
  reason: string;
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

/** Tools that always wait for the user. */
const QUESTION_TOOLS: Record<string, string> = { AskUserQuestion: 'ตอบคำถาม', ExitPlanMode: 'อนุมัติแผน' };
/** Tools that start a shell once allowed: no shell after the grace period = permission prompt. */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
/** Tools that finish within seconds once allowed: still pending after the grace period = permission prompt. */
const INSTANT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Grep', 'Glob']);
const WAITING_FOR_TEXT: Record<string, string> = {
  'dialog open': 'ตอบหน้าต่างที่เปิดค้าง',
  'sandbox request': 'อนุญาต sandbox',
  'goal proposal': 'อนุมัติเป้าหมาย',
};

export function maxOf(...values: Array<number | null | undefined>): number | null {
  let max: number | null = null;
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && (max === null || v > max)) max = v;
  }
  return max;
}

function quietText(ms: number): string {
  if (!Number.isFinite(ms)) return 'นานแล้ว';
  const minutes = Math.floor(ms / MIN);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} ชม. ${minutes % 60} นาที` : `${minutes} นาที`;
}

const clockText = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);
const toolNames = (tools: readonly ProcInfo[]): string => [...new Set(tools.map((p) => p.name))].join(', ');

const result = (verdict: SessionVerdict, blocksShutdown: boolean, reason: string, needsProcessCheck = false): Evaluation => ({
  verdict,
  blocksShutdown,
  reason,
  needsProcessCheck,
});

type Waiting = { since: number; what: string } | 'check' | null;

/** Is the session waiting for the user? 'check' = only a process snapshot can tell. */
function detectWaiting(input: EvaluateInput, busy: boolean, latest: number | null, toolsRunning: boolean | null): Waiting {
  const { file, now } = input;
  if (file.waitingFor !== undefined) return { since: latest ?? now, what: WAITING_FOR_TEXT[file.waitingFor] ?? file.waitingFor };
  if (!busy) return null;
  let needsCheck = false;
  for (const tool of input.pendingTools) {
    const at = tool.at ?? latest ?? now;
    const question = QUESTION_TOOLS[tool.name];
    if (question) return { since: at, what: question };
    if (now - at < PERMISSION_GRACE_MS) continue;
    if (INSTANT_TOOLS.has(tool.name)) return { since: at, what: `อนุญาตให้ใช้ ${tool.name}` };
    if (SHELL_TOOLS.has(tool.name)) {
      if (toolsRunning === null) needsCheck = true;
      else if (!toolsRunning) return { since: at, what: `อนุญาตให้ใช้ ${tool.name}` };
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

  // 1. Commands Claude started, including background tasks: wait while they show any activity.
  let hung: ProcInfo[] = [];
  if (processes && processes.tools.length > 0) {
    const idleMs = now - (processes.toolsActiveAt ?? now);
    const stallMs = settings.toolStallMinutes * MIN;
    if (stallMs <= 0 || idleMs < stallMs) return result('tool', true, `กำลังรันคำสั่ง (${toolNames(processes.tools)})`);
    hung = processes.tools; // no CPU, I/O, output or process changes for too long
  }
  const toolsRunning = processes === null ? null : processes.tools.length > 0 && hung.length === 0;

  // 2. Waiting for the user (permission prompt, question, dialog): finished after waitingMinutes.
  const waiting = detectWaiting(input, busy, latest, toolsRunning);
  if (waiting === 'check') return result('working', true, 'กำลังตรวจว่ารอการอนุญาตอยู่หรือไม่', true);
  const waitMs = settings.waitingMinutes * MIN;
  if (waiting && waitMs > 0) {
    return now - waiting.since >= waitMs
      ? result('stalled', false, `รอ${waiting.what}เกิน ${quietText(waitMs)} จึงนับว่าเสร็จ`)
      : result('waiting', true, `รอผู้ใช้${waiting.what}`);
  }

  const helperBusy =
    processes !== null && processes.helperCpuPercent !== null && processes.helperCpuPercent >= settings.backgroundCpuPercent;
  const stalledMs = settings.stalledMinutes * MIN;

  // 3. A turn in progress: finished only after a long silence.
  if (busy || waiting) {
    if (stalledMs > 0 && quietMs >= stalledMs) {
      if (processes === null) {
        return result(waiting ? 'waiting' : 'working', true, `เงียบมา ${quietText(quietMs)} กำลังตรวจ process เพื่อยืนยัน`, true);
      }
      if (!helperBusy) return result('stalled', false, `ไม่มีความเคลื่อนไหว ${quietText(quietMs)} จึงนับว่าเสร็จ`);
    }
    if (waiting) return result('waiting', true, `รอผู้ใช้${waiting.what}`);
    return result(
      'working',
      true,
      file.status !== undefined ? 'Claude กำลังทำงาน' : 'ไฟล์สถานะไม่มีฟิลด์ status และ transcript ยังไม่จบ turn',
    );
  }

  // 4. Turn over: is anything still going on in the background?
  if (input.scheduledWakeAt !== null && now < input.scheduledWakeAt + WAKE_GRACE_MS) {
    return result('scheduled', true, `ตั้งเวลาทำต่อตอน ${clockText(input.scheduledWakeAt)}`);
  }
  if (input.runningSubagentAt !== null && (stalledMs <= 0 || now - input.runningSubagentAt < stalledMs)) {
    return result('background', true, 'subagent ยังทำงานอยู่');
  }
  if (input.sideActivityAt !== null && now - input.sideActivityAt < SIDE_ACTIVITY_WINDOW_MS) {
    return result('background', true, 'มี subagent หรือไฟล์ของ session ถูกเขียนเมื่อไม่นานนี้');
  }
  if (helperBusy) return result('background', true, `process เบื้องหลังใช้ CPU ${processes!.helperCpuPercent!.toFixed(1)}%`);
  if (hung.length > 0) {
    const idleMs = now - (processes!.toolsActiveAt ?? now);
    return result('stalled', false, `คำสั่งเบื้องหลังไม่ขยับมา ${quietText(idleMs)} จึงนับว่าค้าง (${toolNames(hung)})`);
  }
  return result('idle', false, processes ? 'ว่าง' : 'ว่าง (ยังไม่ได้ตรวจ process เบื้องหลัง)');
}
