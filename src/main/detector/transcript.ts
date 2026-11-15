import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { TranscriptState } from '../../shared/types';

/** System entries Claude Code writes once a turn has finished. */
const ENDED_SYSTEM_SUBTYPES = new Set(['stop_hook_summary', 'turn_duration']);
/** Entries written while a model request is in flight. */
const RUNNING_TYPES = new Set(['api-request', 'api-request-blob', 'progress']);
/** Assistant stop reasons that do not end the turn. */
const CONTINUING_STOP_REASONS = new Set(['tool_use', 'pause_turn']);

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
}

export function analyzeTranscriptLines(lines: readonly string[]): TranscriptInfo {
  const pending = new Map<string, PendingTool>();
  let scheduledWakeAt: number | null = null;
  for (const line of lines) {
    const entry = parseEntry(line);
    if (!entry) continue;
    const parsed = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
    const at = Number.isFinite(parsed) ? parsed : null;
    if (entry.type === 'assistant') {
      for (const block of blocksOf(entry)) {
        if (block.type !== 'tool_use' || typeof block.id !== 'string') continue;
        const name = typeof block.name === 'string' ? block.name : '';
        pending.set(block.id, { id: block.id, name, at });
        if (name === 'ScheduleWakeup') {
          const input = (block.input ?? {}) as Record<string, unknown>;
          const delay = Number(input.delaySeconds);
          if (input.stop === true) scheduledWakeAt = null;
          else if (at !== null && Number.isFinite(delay)) scheduledWakeAt = at + Math.min(3600, Math.max(60, delay)) * 1000;
        }
      }
    } else if (entry.type === 'user') {
      for (const block of blocksOf(entry)) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') pending.delete(block.tool_use_id);
      }
    }
    if (endsTurn(entry)) pending.clear(); // calls left from an interrupted turn no longer matter
  }
  return { state: classifyTranscriptLines(lines), pendingTools: [...pending.values()], scheduledWakeAt };
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
  let info: TranscriptInfo = { state: 'unknown', pendingTools: [], scheduledWakeAt: null };
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

/** Caches transcript analysis by file size and modification time. */
export class TranscriptInfoCache {
  private readonly entries = new Map<string, { mtimeMs: number; size: number; info: TranscriptInfo }>();

  async get(file: string, mtimeMs: number, size: number): Promise<TranscriptInfo> {
    const hit = this.entries.get(file);
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.info;
    const info = await readTranscriptInfo(file, size);
    if (this.entries.size > 1000) this.entries.clear();
    this.entries.set(file, { mtimeMs, size, info });
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

const MISSING_RECHECK_MS = 5 * 60_000;

/** Finds `<claudeDir>/projects/<slug>/<sessionId>.jsonl`, falling back to a scan of all projects. */
export class TranscriptLocator {
  private readonly cache = new Map<string, { file: string | null; checkedAt: number }>();

  async locate(projectsDir: string, sessionId: string, cwd: string | undefined, now: number): Promise<string | null> {
    const cached = this.cache.get(sessionId);
    if (cached?.file && (await exists(cached.file))) return cached.file;
    if (cached && !cached.file && now - cached.checkedAt < MISSING_RECHECK_MS) return null;

    const name = `${sessionId}.jsonl`;
    let found: string | null = null;
    if (cwd) {
      const direct = path.join(projectsDir, projectSlug(cwd), name);
      if (await exists(direct)) found = direct;
    }
    if (!found) {
      let dirs: string[] = [];
      try {
        dirs = await readdir(projectsDir);
      } catch {
        dirs = [];
      }
      for (const dir of dirs) {
        const candidate = path.join(projectsDir, dir, name);
        if (await exists(candidate)) {
          found = candidate;
          break;
        }
      }
    }
    if (this.cache.size > 500) this.cache.clear();
    this.cache.set(sessionId, { file: found, checkedAt: now });
    return found;
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
