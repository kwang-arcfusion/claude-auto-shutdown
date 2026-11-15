import type { SessionVerdict, Settings, TranscriptState } from '../../shared/types';
import type { ProcInfo } from './processes';

/**
 * `<claudeDir>/sessions/<pid>.json`, written by every running Claude Code process
 * (desktop app sessions and CLI alike). Internal format, observed on Claude Code 2.1.325:
 * {"pid":28348,"sessionId":"…","cwd":"…","procStart":"134391962772404597","status":"busy",
 *  "statusUpdatedAt":1794723027028,"updatedAt":…,"entrypoint":"claude-desktop",…}
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
}

export interface ProcessFacts {
  tools: ProcInfo[];
  /** Total CPU % of helper processes; null when it could not be measured. */
  helperCpuPercent: number | null;
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

/** An idle session whose side folder was written this recently still counts as working. */
export const SIDE_ACTIVITY_WINDOW_MS = 2 * 60_000;

export function maxOf(...values: Array<number | null | undefined>): number | null {
  let max: number | null = null;
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && (max === null || v > max)) max = v;
  }
  return max;
}

function quietText(ms: number): string {
  if (!Number.isFinite(ms)) return 'นานแล้ว';
  const minutes = Math.floor(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} ชม. ${minutes % 60} นาที` : `${minutes} นาที`;
}

const result = (verdict: SessionVerdict, blocksShutdown: boolean, reason: string, needsProcessCheck = false): Evaluation => ({
  verdict,
  blocksShutdown,
  reason,
  needsProcessCheck,
});

export function evaluateSession(input: EvaluateInput): Evaluation {
  const { file, processes, now, settings } = input;

  if (processes && processes.tools.length > 0) {
    const names = [...new Set(processes.tools.map((p) => p.name))].join(', ');
    return result('tool', true, `มีคำสั่งที่ Claude สั่งไว้ยังรันอยู่ (${names})`);
  }

  const helperBusy =
    processes !== null && processes.helperCpuPercent !== null && processes.helperCpuPercent >= settings.backgroundCpuPercent;
  // Without a status field, fall back to the transcript; an unreadable transcript counts as busy.
  const busy = file.status !== undefined ? file.status === 'busy' : input.transcriptState !== 'ended';
  const waiting = file.waitingFor !== undefined;
  const latest = maxOf(input.lastActivityAt, input.sideActivityAt);
  const quietMs = latest === null ? Number.POSITIVE_INFINITY : now - latest;

  if (busy || waiting) {
    const stalledMs = settings.stalledMinutes * 60_000;
    if (stalledMs > 0 && quietMs >= stalledMs) {
      if (processes === null) {
        return result(waiting ? 'waiting' : 'working', true, `เงียบมา ${quietText(quietMs)} กำลังตรวจ process เพื่อยืนยัน`, true);
      }
      if (!helperBusy) {
        return result('stalled', false, `ไม่มีความเคลื่อนไหว ${quietText(quietMs)} จึงนับว่าเสร็จ${waiting ? ' (ค้างรอผู้ใช้ตอบ)' : ''}`);
      }
    }
    if (waiting) return result('waiting', true, `รอผู้ใช้ตอบ (${file.waitingFor})`);
    return result(
      'working',
      true,
      file.status !== undefined ? 'Claude กำลังทำงาน' : 'ไฟล์สถานะไม่มีฟิลด์ status และ transcript ยังไม่จบ turn',
    );
  }

  if (input.sideActivityAt !== null && now - input.sideActivityAt < SIDE_ACTIVITY_WINDOW_MS) {
    return result('background', true, 'มี subagent หรือไฟล์ของ session ถูกเขียนเมื่อไม่นานนี้');
  }
  if (helperBusy) {
    return result('background', true, `process เบื้องหลังใช้ CPU ${processes!.helperCpuPercent!.toFixed(1)}%`);
  }
  return result('idle', false, processes ? 'ว่าง' : 'ว่าง (ยังไม่ได้ตรวจ process เบื้องหลัง)');
}
