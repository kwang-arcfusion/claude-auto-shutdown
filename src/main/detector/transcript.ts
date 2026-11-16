import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { TranscriptState } from '../../shared/types';

/** System entries Claude Code writes once a turn has finished. */
const ENDED_SYSTEM_SUBTYPES = new Set(['stop_hook_summary', 'turn_duration']);
/** Entries written while a model request is in flight. */
const RUNNING_TYPES = new Set(['api-request', 'api-request-blob', 'progress']);
/** Assistant stop reasons that do not end the turn (max_tokens: Claude Code resumes by itself). */
const CONTINUING_STOP_REASONS = new Set(['tool_use', 'pause_turn', 'max_tokens']);
/** Tools whose input.command runs in a shell. */
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor']);
/** Timed waits are trusted only this far (same limit as a running `sleep` process). */
const MAX_TIMED_WAIT_SECONDS = 6 * 3600;
const SECONDS_PER_UNIT: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };

/**
 * Seconds a shell command deliberately waits: PowerShell `Start-Sleep 600` / `-Seconds 600` /
 * `-Milliseconds 500` and its `sleep` alias, `sleep 10m`, `timeout /t 60`, `time.sleep(5)`. Several
 * waits add up; the total is capped. 0 when there is none.
 */
export function timedWaitSeconds(command: string): number {
  let total = 0;
  for (const m of command.matchAll(/\bStart-Sleep\b\s*(?:-(\w+)\s*)?(\d+(?:\.\d+)?)/gi)) {
    total += /^m/i.test(m[1] ?? '') ? Number(m[2]) / 1000 : Number(m[2]);
  }
  for (const m of command.matchAll(/(?:^|[\s;&|(])sleep\s+(\d+(?:\.\d+)?)([smhd]?)(?![\w.])/gi)) {
    total += Number(m[1]) * SECONDS_PER_UNIT[m[2]!.toLowerCase()]!;
  }
  for (const m of command.matchAll(/\btimeout(?:\.exe)?\s+[/-]t\s+(\d+)/gi)) total += Number(m[1]);
  for (const m of command.matchAll(/\btime\.sleep\(\s*(\d+(?:\.\d+)?)\s*\)/g)) total += Number(m[1]);
  return Number.isFinite(total) ? Math.min(total, MAX_TIMED_WAIT_SECONDS) : 0;
}

/** A CronCreate job (fixed-interval /loop, reminder). Claude Code keeps it in memory only. */
export interface CronJob {
  id: string;
  cron: string;
  recurring: boolean;
  createdAt: number;
}

function resultText(block: Record<string, unknown>): string {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part !== null && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
    .join('\n');
}

type Entry = Record<string, unknown> & { type: string };

function parseEntry(line: string): Entry | null {
  const text = line.trim();
  if (!text) return null;
  try {
    const entry = JSON.parse(text) as unknown;
    return entry !== null && typeof entry === 'object' && typeof (entry as Entry).type === 'string' ? (entry as Entry) : null;
  } catch {
    return null; // a partial line at the edge of the read window
  }
}

const messageOf = (entry: Entry): Record<string, unknown> => (entry.message ?? {}) as Record<string, unknown>;

function blocksOf(entry: Entry): Array<Record<string, unknown>> {
  const content = messageOf(entry).content;
  return Array.isArray(content) ? (content.filter((b) => b !== null && typeof b === 'object') as Array<Record<string, unknown>>) : [];
}

function firstText(entry: Entry): string {
  const content = messageOf(entry).content;
  if (typeof content === 'string') return content;
  for (const block of blocksOf(entry)) if (block.type === 'text' && typeof block.text === 'string') return block.text;
  return '';
}

const isInterrupt = (entry: Entry): boolean => entry.type === 'user' && firstText(entry).startsWith('[Request interrupted by user');

/** Whether this entry marks the end of a turn. */
function endsTurn(entry: Entry): boolean {
  if (entry.type === 'system') return ENDED_SYSTEM_SUBTYPES.has(String(entry.subtype));
  if (entry.type === 'assistant') {
    const stop = messageOf(entry).stop_reason;
    return typeof stop === 'string' && !CONTINUING_STOP_REASONS.has(stop);
  }
  return isInterrupt(entry);
}

/**
 * Works out from the end of a transcript whether the last turn has finished.
 * Metadata entries (titles, modes, attachments, ...) are skipped.
 */
export function classifyTranscriptLines(lines: readonly string[]): TranscriptState {
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseEntry(lines[i]!);
    if (!entry) continue;
    switch (entry.type) {
      case 'system':
        if (ENDED_SYSTEM_SUBTYPES.has(String(entry.subtype))) return 'ended';
        continue;
      case 'assistant':
        return endsTurn(entry) ? 'ended' : 'running';
      case 'user':
        if (entry.isMeta === true) continue;
        return isInterrupt(entry) ? 'ended' : 'running';
      default:
        if (RUNNING_TYPES.has(entry.type)) return 'running';
        continue;
    }
  }
  return 'unknown';
}

export interface PendingTool {
  id: string;
  name: string;
  /** When the call was written (ms), if the entry had a timestamp. */
  at: number | null;
}

export interface TranscriptInfo {
  state: TranscriptState;
  /** Tool calls in the current turn without a result yet: running, or waiting for permission. */
  pendingTools: PendingTool[];
  /** When the latest ScheduleWakeup call will wake the session (ms), unless the loop was stopped. */
  scheduledWakeAt: number | null;
  /** When the latest timed wait in a command ends (ms): `Start-Sleep 3600` started then plus an hour. */
  timedWaitEndsAt: number | null;
  /** CronCreate jobs created and not deleted in the part that was read. */
  crons: CronJob[];
  /** Job ids deleted with CronDelete in the part that was read. */
  deletedCrons: string[];
  /** The last turn ended with an API error (usage limit, overload...): its text. */
  endedWithError: string | null;
}

export const emptyTranscriptInfo = (): TranscriptInfo => ({
  state: 'unknown',
  pendingTools: [],
  scheduledWakeAt: null,
  timedWaitEndsAt: null,
  crons: [],
  deletedCrons: [],
  endedWithError: null,
});

export function analyzeTranscriptLines(lines: readonly string[]): TranscriptInfo {
  const pending = new Map<string, PendingTool>();
  const cronCalls = new Map<string, { cron: string; at: number | null }>();
  const crons = new Map<string, CronJob>();
  const deletedCrons: string[] = [];
  let scheduledWakeAt: number | null = null;
  let timedWaitEndsAt: number | null = null;
  let lastError: string | null = null;
  for (const line of lines) {
    const entry = parseEntry(line);
    if (!entry) continue;
    // An API error ends the turn as an assistant entry (isApiErrorMessage, e.g. a 429 "You've hit
    // your 5-hour limit"); any later reply or prompt means Claude went on.
    if (entry.type === 'assistant') lastError = entry.isApiErrorMessage === true ? firstText(entry).replace(/\s+/g, ' ').trim().slice(0, 140) || 'API error' : null;
    else if (entry.type === 'user' && entry.isMeta !== true && !blocksOf(entry).some((b) => b.type === 'tool_result')) lastError = null;
    const parsed = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
    const at = Number.isFinite(parsed) ? parsed : null;
    if (entry.type === 'assistant') {
      for (const block of blocksOf(entry)) {
        if (block.type !== 'tool_use' || typeof block.id !== 'string') continue;
        const name = typeof block.name === 'string' ? block.name : '';
        const input = (block.input ?? {}) as Record<string, unknown>;
        pending.set(block.id, { id: block.id, name, at });
        if (name === 'ScheduleWakeup') {
          const delay = Number(input.delaySeconds);
          if (input.stop === true) scheduledWakeAt = null;
          else if (at !== null && Number.isFinite(delay)) scheduledWakeAt = at + Math.min(3600, Math.max(60, delay)) * 1000;
        } else if (name === 'CronCreate' && typeof input.cron === 'string') {
          cronCalls.set(block.id, { cron: input.cron, at });
        } else if (name === 'CronDelete' && typeof input.id === 'string') {
          crons.delete(input.id);
          deletedCrons.push(input.id);
        } else if (COMMAND_TOOLS.has(name) && typeof input.command === 'string' && at !== null) {
          const seconds = timedWaitSeconds(input.command);
          if (seconds > 0) timedWaitEndsAt = Math.max(timedWaitEndsAt ?? 0, at + seconds * 1000);
        }
      }
    } else if (entry.type === 'user') {
      for (const block of blocksOf(entry)) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        pending.delete(block.tool_use_id);
        const call = cronCalls.get(block.tool_use_id);
        if (call && block.is_error !== true) {
          // "Scheduled recurring job <id> (...)" / "Scheduled one-shot task <id> (...)"
          const text = resultText(block);
          const match = /Scheduled (recurring job|one-shot task) (\S+) \(/.exec(text);
          const id = match?.[2] ?? block.tool_use_id;
          crons.set(id, { id, cron: call.cron, recurring: match ? match[1] === 'recurring job' : true, createdAt: call.at ?? at ?? 0 });
        }
      }
    }
    if (endsTurn(entry)) pending.clear(); // calls left from an interrupted turn no longer matter
  }
  return {
    state: classifyTranscriptLines(lines),
    pendingTools: [...pending.values()],
    scheduledWakeAt,
    timedWaitEndsAt,
    crons: [...crons.values()],
    deletedCrons,
    endedWithError: lastError,
  };
}

async function readTail(file: string, size: number, maxBytes: number): Promise<string[]> {
  const handle = await open(file, 'r');
  try {
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // the first line is cut off
    return lines;
  } finally {
    await handle.close();
  }
}

export async function readTranscriptInfo(file: string, size: number): Promise<TranscriptInfo> {
  let info: TranscriptInfo = emptyTranscriptInfo();
  // Tool results can make single lines huge, so widen the window once if needed.
  for (const window of [256 * 1024, 4 * 1024 * 1024]) {
    info = analyzeTranscriptLines(await readTail(file, size, window));
    if (info.state !== 'unknown' || size <= window) break;
  }
  return info;
}

export async function readTranscriptState(file: string, size: number): Promise<TranscriptState> {
  return (await readTranscriptInfo(file, size)).state;
}

/**
 * Caches transcript analysis by file size and modification time. Least recently used entries
 * are evicted one at a time, so a session with hundreds of subagents never forces a re-read
 * of everything.
 */
export class TranscriptInfoCache {
  private readonly entries = new Map<string, { mtimeMs: number; size: number; info: TranscriptInfo }>();

  constructor(private readonly limit = 2000) {}

  get size(): number {
    return this.entries.size;
  }

  async get(file: string, mtimeMs: number, size: number): Promise<TranscriptInfo> {
    const hit = this.entries.get(file);
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
      this.entries.delete(file); // Map order = recency
      this.entries.set(file, hit);
      return hit.info;
    }
    const info = await readTranscriptInfo(file, size);
    this.entries.delete(file);
    this.entries.set(file, { mtimeMs, size, info });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    return info;
  }
}

/** Claude Code's project folder name for a working directory. */
export const projectSlug = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-');

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** How often to look again for copies of a session's transcript in other project folders. */
export const TRANSCRIPT_RESCAN_MS = 2 * 60_000;

export interface TranscriptCopy {
  file: string;
  mtimeMs: number;
  size: number;
}

/**
 * Finds `<claudeDir>/projects/<slug>/<sessionId>.jsonl`. One session can have copies in several
 * project folders: after it moves into a worktree, the status file's cwd names the worktree while
 * Claude keeps writing the transcript under the folder it started in (the copy it left ends with
 * a "relocated" entry). So every folder is searched, and the most recently written copy is the
 * live one; the cwd alone can point at a copy that stopped hours ago.
 */
export class TranscriptLocator {
  private readonly cache = new Map<string, { files: string[]; checkedAt: number }>();

  /** Every copy of the session's transcript, most recently written first. */
  async locateAll(projectsDir: string, sessionId: string, cwd: string | undefined, now: number): Promise<TranscriptCopy[]> {
    let entry = this.cache.get(sessionId);
    if (!entry || now - entry.checkedAt >= TRANSCRIPT_RESCAN_MS) {
      entry = { files: await this.search(projectsDir, sessionId, cwd), checkedAt: now };
      this.cache.delete(sessionId);
      this.cache.set(sessionId, entry);
      if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    }
    const copies = await Promise.all(
      entry.files.map(async (file): Promise<TranscriptCopy | null> => {
        try {
          const stats = await stat(file);
          return { file, mtimeMs: stats.mtimeMs, size: stats.size };
        } catch {
          return null; // deleted since the search
        }
      }),
    );
    const found = copies.filter((c): c is TranscriptCopy => c !== null).sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (found.length < entry.files.length) this.cache.delete(sessionId); // search again next time
    return found;
  }

  /** The live copy (most recently written), or null. */
  async locate(projectsDir: string, sessionId: string, cwd: string | undefined, now: number): Promise<string | null> {
    return (await this.locateAll(projectsDir, sessionId, cwd, now))[0]?.file ?? null;
  }

  private async search(projectsDir: string, sessionId: string, cwd: string | undefined): Promise<string[]> {
    const name = `${sessionId}.jsonl`;
    let dirs: string[] = [];
    try {
      dirs = await readdir(projectsDir);
    } catch {
      dirs = [];
    }
    // The cwd's folder first (the usual place), then every other one.
    const first = cwd ? projectSlug(cwd) : null;
    const ordered = first ? [first, ...dirs.filter((d) => d !== first)] : dirs;
    const hits = await Promise.all(
      ordered.map(async (dir) => {
        const candidate = path.join(projectsDir, dir, name);
        return (await exists(candidate)) ? candidate : null;
      }),
    );
    return hits.filter((file): file is string => file !== null);
  }
}

/** Latest modification time of any file under `dir` (e.g. subagent transcripts). */
export async function latestMtimeUnder(dir: string, depth = 3): Promise<number | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let latest: number | null = null;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let mtime: number | null = null;
    if (entry.isDirectory()) {
      if (depth > 0) mtime = await latestMtimeUnder(full, depth - 1);
    } else if (entry.isFile()) {
      try {
        mtime = (await stat(full)).mtimeMs;
      } catch {
        mtime = null;
      }
    }
    if (mtime !== null && (latest === null || mtime > latest)) latest = mtime;
  }
  return latest;
}
