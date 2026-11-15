import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { TranscriptState } from '../../shared/types';

/** System entries Claude Code writes once a turn has finished. */
const ENDED_SYSTEM_SUBTYPES = new Set(['stop_hook_summary', 'turn_duration']);
/** Entries written while a model request is in flight. */
const RUNNING_TYPES = new Set(['api-request', 'api-request-blob', 'progress']);

function firstText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string') return text;
      }
    }
  }
  return '';
}

/**
 * Works out from the end of a transcript whether the last turn has finished.
 * Metadata entries (titles, modes, attachments, ...) are skipped.
 */
export function classifyTranscriptLines(lines: readonly string[]): TranscriptState {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a partial line at the edge of the read window
    }
    if (!entry || typeof entry.type !== 'string') continue;
    const message = (entry.message ?? {}) as Record<string, unknown>;
    switch (entry.type) {
      case 'system':
        if (ENDED_SYSTEM_SUBTYPES.has(String(entry.subtype))) return 'ended';
        continue;
      case 'assistant': {
        const stop = message.stop_reason;
        if (stop === 'tool_use' || stop === 'pause_turn' || stop === null || stop === undefined) return 'running';
        return 'ended';
      }
      case 'user': {
        if (entry.isMeta === true) continue;
        if (firstText(message.content).startsWith('[Request interrupted by user')) return 'ended';
        return 'running';
      }
      default:
        if (RUNNING_TYPES.has(entry.type)) return 'running';
        continue;
    }
  }
  return 'unknown';
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

export async function readTranscriptState(file: string, size: number): Promise<TranscriptState> {
  // Tool results can make single lines huge, so widen the window once if needed.
  for (const window of [256 * 1024, 4 * 1024 * 1024]) {
    const state = classifyTranscriptLines(await readTail(file, size, window));
    if (state !== 'unknown' || size <= window) return state;
  }
  return 'unknown';
}

/** Caches transcript states by file size and modification time. */
export class TranscriptStateCache {
  private readonly entries = new Map<string, { mtimeMs: number; size: number; state: TranscriptState }>();

  async get(file: string, mtimeMs: number, size: number): Promise<TranscriptState> {
    const hit = this.entries.get(file);
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.state;
    const state = await readTranscriptState(file, size);
    if (this.entries.size > 500) this.entries.clear();
    this.entries.set(file, { mtimeMs, size, state });
    return state;
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
