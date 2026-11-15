import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Aggregate, DetectionResult, SessionInfo, Settings } from '../../shared/types';
import { ActivitySampler, procKey, type ProcActivity, type ProcInfo, type ProcessSnapshot, type SnapshotSource } from './processes';
import {
  evaluateSession,
  maxOf,
  parseSessionFile,
  type Evaluation,
  type ProcessFacts,
  type SessionActivity,
  type SessionFile,
} from './session';
import { latestMtimeUnder, TranscriptInfoCache, TranscriptLocator, type TranscriptInfo } from './transcript';
import { classifyDescendants, indexProcesses, sessionIdentity, sleepEndsAt } from './tree';

/** Tool processes count as active at or above this CPU use (% of one core)... */
const TOOL_ACTIVE_CPU_PERCENT = 2;
/** ...or this much I/O (disk or network). */
const TOOL_ACTIVE_IO_BYTES_PER_SEC = 1024;
/** A timed `sleep N` stays active until this long after it should have ended. */
const SLEEP_GRACE_MS = 60_000;
/** Subagent transcripts not written for this long are not read. */
const SUBAGENT_LOOKBACK_MS = 6 * 60 * 60_000;
const MISSING_RECHECK_MS = 5 * 60_000;

export function defaultClaudeDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CLAUDE_CONFIG_DIR?.trim();
  return fromEnv ? fromEnv : path.join(os.homedir(), '.claude');
}

export function resolveClaudeDir(settings: Settings): string {
  return settings.claudeDir || defaultClaudeDir();
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface Detector {
  detect(settings: Settings, options?: DetectOptions): Promise<DetectionResult>;
}

export interface DetectOptions {
  /** Inspect processes even when a session is clearly busy (for display). */
  forceSnapshot?: boolean;
  /** Never inspect processes (display-only checks while disarmed): the result is marked partial. */
  skipProcesses?: boolean;
}

export interface ClaudeDetectorOptions {
  claudeDir: () => string;
  snapshotter: SnapshotSource;
  /** Where Claude Code keeps per-session tool output: <tempRoot>/<hash>/<sessionId>/... */
  tempRoot?: string;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

interface ToolWatch {
  signature: string;
  activeAt: number;
  observedAt: number;
}

function toInfo(file: SessionFile, activity: SessionActivity, evaluation: Evaluation, processes: ProcessFacts | null): SessionInfo {
  return {
    pid: file.pid,
    sessionId: file.sessionId,
    name: file.name ?? '',
    cwd: file.cwd ?? '',
    entrypoint: file.entrypoint ?? '',
    status: file.status ?? null,
    waitingFor: file.waitingFor ?? null,
    verdict: evaluation.verdict,
    blocksShutdown: evaluation.blocksShutdown,
    reason: evaluation.reason,
    lastActivityAt: maxOf(activity.lastActivityAt, activity.sideActivityAt),
    transcriptState: activity.transcriptState,
    toolProcesses: processes ? [...new Set(processes.tools.map((p) => p.name))] : [],
    helperCpuPercent: processes?.helperCpuPercent ?? null,
    processesChecked: processes !== null,
  };
}

function aggregateOf(sessions: readonly SessionInfo[], error: string | null): Aggregate {
  if (sessions.some((s) => s.blocksShutdown)) return 'busy';
  return error ? 'unknown' : 'idle';
}

function sortSessions(sessions: SessionInfo[]): SessionInfo[] {
  return sessions.sort(
    (a, b) => Number(b.blocksShutdown) - Number(a.blocksShutdown) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0),
  );
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Decides whether any Claude Code session is still working, from
 * `<claudeDir>/sessions/*.json`, the session transcripts and (when needed) the process tree.
 */
export class ClaudeDetector implements Detector {
  private readonly sampler = new ActivitySampler();
  private readonly locator = new TranscriptLocator();
  private readonly transcripts = new TranscriptInfoCache();
  private readonly toolWatch = new Map<string, ToolWatch>();
  private readonly tempDirs = new Map<string, { dir: string | null; checkedAt: number }>();
  private readonly tempRoot: string;
  private readonly now: () => number;
  private readonly pidAlive: (pid: number) => boolean;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: ClaudeDetectorOptions) {
    this.tempRoot = options.tempRoot ?? path.join(os.tmpdir(), 'claude');
    this.now = options.now ?? Date.now;
    this.pidAlive = options.isPidAlive ?? isPidAlive;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async detect(settings: Settings, detectOptions: DetectOptions = {}): Promise<DetectionResult> {
    const startedAt = this.now();
    const claudeDir = this.options.claudeDir();
    const finish = (aggregate: Aggregate, sessions: SessionInfo[], error: string | null, usedProcessSnapshot: boolean) => ({
      at: startedAt,
      aggregate,
      sessions: sortSessions(sessions),
      error,
      claudeDir,
      usedProcessSnapshot,
      durationMs: this.now() - startedAt,
    });

    const sessionsDir = path.join(claudeDir, 'sessions');
    let names: string[];
    try {
      names = await readdir(sessionsDir);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      const message = missing
        ? `ไม่พบโฟลเดอร์ ${sessionsDir} (ตรวจค่า "โฟลเดอร์ Claude" ในหน้าตั้งค่า)`
        : `อ่านโฟลเดอร์ ${sessionsDir} ไม่ได้: ${(error as Error).message}`;
      return finish('unknown', [], message, false);
    }

    const { files, unreadableLive } = await this.loadSessionFiles(sessionsDir, names);
    const fileError = unreadableLive > 0 ? `อ่านไฟล์สถานะของ session ที่ยังเปิดอยู่ไม่ได้ ${unreadableLive} ไฟล์` : null;
    const live = files.filter((f) => this.pidAlive(f.pid));
    const now = this.now();
    const projectsDir = path.join(claudeDir, 'projects');
    const activity = await Promise.all(live.map((f) => this.activityFor(projectsDir, f, now, settings)));

    // Cheap pass from files only: one clearly busy session is enough to keep the machine on.
    const cheap = live.map((file, i) => evaluateSession({ file, ...activity[i]!, processes: null, now, settings }));
    const clearlyBusy = cheap.some((e) => e.blocksShutdown && !e.needsProcessCheck);
    const cheapInfos = (): SessionInfo[] => live.map((f, i) => toInfo(f, activity[i]!, cheap[i]!, null));

    if (!detectOptions.forceSnapshot && (clearlyBusy || live.length === 0)) {
      const sessions = cheapInfos();
      return finish(aggregateOf(sessions, fileError), sessions, fileError, false);
    }
    if (detectOptions.skipProcesses && !detectOptions.forceSnapshot) {
      // Display-only check: no PowerShell, so an idle verdict here is unverified.
      const sessions = cheapInfos();
      return { ...finish(aggregateOf(sessions, fileError), sessions, fileError, false), partial: true };
    }

    const maxAgeMs = Math.max(3 * settings.pollIntervalSec * 1000, 120_000);
    let sample: { snapshot: ProcessSnapshot; usage: Map<string, ProcActivity> | null };
    try {
      sample = await this.snapshotWithUsage(maxAgeMs, live.map((f) => f.pid));
    } catch (error) {
      const sessions = cheapInfos();
      return finish(clearlyBusy ? 'busy' : 'unknown', sessions, (error as Error).message, false);
    }

    const checkedAt = this.now();
    const index = indexProcesses(sample.snapshot.procs);
    const usage = sample.usage;
    const watched = new Set<string>();
    const sessions: SessionInfo[] = [];
    for (const [i, file] of live.entries()) {
      const proc = index.byPid.get(file.pid);
      const identity = sessionIdentity(file, proc);
      if (identity === 'stale' || !proc) continue; // left behind by a process that has exited
      if (identity === 'unsure') {
        // Never guess idle about a live session we cannot pin down.
        const unsure: Evaluation = {
          verdict: 'working',
          blocksShutdown: true,
          reason: 'ยืนยันไม่ได้ว่า process นี้เป็นของ session นี้ จึงยังไม่ปิดเครื่อง',
          needsProcessCheck: false,
        };
        sessions.push(toInfo(file, activity[i]!, unsure, null));
        continue;
      }
      const { tools, helpers, newestCreatedAt } = classifyDescendants(index, proc);
      const rate = (p: ProcInfo): ProcActivity | undefined => usage?.get(procKey(p));
      const helperCpuPercent = usage ? helpers.reduce((sum, p) => sum + (rate(p)?.cpuPercent ?? 0), 0) : null;
      const helpersActiveNow = usage
        ? helpers.some((p) => (rate(p)?.cpuPercent ?? 0) >= TOOL_ACTIVE_CPU_PERCENT || (rate(p)?.ioBytesPerSec ?? 0) >= TOOL_ACTIVE_IO_BYTES_PER_SEC)
        : true;
      const key = `${file.pid}:${file.procStart ?? ''}`;
      let toolsActiveAt: number | null = null;
      let shellActiveAt: number | null = null;
      if (tools.length > 0) {
        watched.add(key);
        toolsActiveAt = await this.toolsActiveAt(key, file.sessionId, tools, usage, checkedAt, maxAgeMs);
      } else if (file.status === 'shell' && helpers.length > 0) {
        // Claude says a shell is running but none has a known marker: watch everything under it.
        watched.add(`${key}:shell`);
        shellActiveAt = await this.toolsActiveAt(`${key}:shell`, file.sessionId, helpers, usage, checkedAt, maxAgeMs);
      }
      const processes: ProcessFacts = { tools, helperCpuPercent, toolsActiveAt, newestChildAt: newestCreatedAt, helpersActiveNow, shellActiveAt };
      const evaluation = evaluateSession({ file, ...activity[i]!, processes, now: checkedAt, settings });
      sessions.push(toInfo(file, activity[i]!, evaluation, processes));
    }
    for (const key of this.toolWatch.keys()) if (!watched.has(key)) this.toolWatch.delete(key);
    return finish(aggregateOf(sessions, fileError), sessions, fileError, true);
  }

  private async loadSessionFiles(dir: string, names: readonly string[]): Promise<{ files: SessionFile[]; unreadableLive: number }> {
    const files: SessionFile[] = [];
    let unreadableLive = 0;
    await Promise.all(
      names.map(async (name) => {
        const match = /^(\d+)\.json$/.exec(name);
        if (!match) return;
        let parsed: SessionFile | null = null;
        try {
          parsed = parseSessionFile(await readFile(path.join(dir, name), 'utf8'));
        } catch {
          parsed = null;
        }
        if (parsed) files.push(parsed);
        else if (this.pidAlive(Number(match[1]))) unreadableLive++;
      }),
    );
    return { files, unreadableLive };
  }

  private async activityFor(projectsDir: string, file: SessionFile, now: number, settings: Settings): Promise<SessionActivity> {
    const transcript = await this.locator.locate(projectsDir, file.sessionId, file.cwd, now);
    let transcriptMtime: number | null = null;
    let info: TranscriptInfo = { state: 'unknown', pendingTools: [], scheduledWakeAt: null };
    if (transcript) {
      try {
        const stats = await stat(transcript);
        transcriptMtime = stats.mtimeMs;
        info = await this.transcripts.get(transcript, stats.mtimeMs, stats.size);
      } catch {
        // removed between locate and stat
      }
    }
    const lastActivityAt = maxOf(transcriptMtime, file.statusUpdatedAt, file.updatedAt);

    // The session folder (subagent transcripts, which can number in the hundreds) only matters
    // once the turn is over, or when a busy turn has gone quiet long enough for the silence rule.
    // Skip it while a turn is visibly active, which is most of the night.
    const stalledMs = settings.stalledMinutes * 60_000;
    const quietMs = lastActivityAt === null ? Number.POSITIVE_INFINITY : now - lastActivityAt;
    const needFolder = file.status !== 'busy' || file.waitingFor !== undefined || (stalledMs > 0 && quietMs >= stalledMs);
    const folder =
      transcript && needFolder
        ? await this.scanSessionFolder(path.join(path.dirname(transcript), file.sessionId), now, stalledMs)
        : { latest: null, runningSubagentAt: null };
    return {
      transcriptState: info.state,
      pendingTools: info.pendingTools,
      scheduledWakeAt: info.scheduledWakeAt,
      lastActivityAt,
      sideActivityAt: folder.latest,
      runningSubagentAt: folder.runningSubagentAt,
    };
  }

  /**
   * One pass over the session's side folder: its latest write, and the newest subagent
   * transcript that is still mid-turn. tool-results/ is skipped (written during tool calls,
   * when the session is busy anyway). Only subagents recent enough to matter are read.
   */
  private async scanSessionFolder(dir: string, now: number, stalledMs: number): Promise<{ latest: number | null; runningSubagentAt: number | null }> {
    let latest: number | null = null;
    const subagents: Array<{ file: string; mtimeMs: number; size: number }> = [];
    const walk = async (folder: string, depth: number, inSubagents: boolean): Promise<void> => {
      let entries;
      try {
        entries = await readdir(folder, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) {
          if (depth > 0 && entry.name !== 'tool-results') await walk(full, depth - 1, inSubagents || entry.name === 'subagents');
        } else if (entry.isFile()) {
          try {
            const stats = await stat(full);
            if (latest === null || stats.mtimeMs > latest) latest = stats.mtimeMs;
            if (inSubagents && entry.name.endsWith('.jsonl')) subagents.push({ file: full, mtimeMs: stats.mtimeMs, size: stats.size });
          } catch {
            // removed meanwhile
          }
        }
      }
    };
    await walk(dir, 2, false);

    const window = stalledMs > 0 ? Math.min(stalledMs, SUBAGENT_LOOKBACK_MS) : SUBAGENT_LOOKBACK_MS;
    const recent = subagents.filter((s) => now - s.mtimeMs < window).sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const s of recent) {
      const info = await this.transcripts.get(s.file, s.mtimeMs, s.size);
      if (info.state === 'running') return { latest, runningSubagentAt: s.mtimeMs };
    }
    return { latest, runningSubagentAt: null };
  }

  /**
   * Remembers when a session's tool processes last did anything: used CPU or I/O, wrote
   * output, started or ended a process, or were inside a timed `sleep`. A gap in
   * observation counts as activity, so time that was not watched never counts as quiet.
   */
  private async toolsActiveAt(
    key: string,
    sessionId: string,
    tools: readonly ProcInfo[],
    usage: Map<string, ProcActivity> | null,
    now: number,
    maxAgeMs: number,
  ): Promise<number> {
    const signature = tools
      .map(procKey)
      .sort()
      .join('|');
    const previous = this.toolWatch.get(key);
    const watchedBefore = previous !== undefined && now - previous.observedAt <= maxAgeMs;
    let activeAt = watchedBefore ? previous.activeAt : now;
    const sum = (pick: (a: ProcActivity) => number): number => tools.reduce((total, p) => total + (usage?.get(procKey(p)) ? pick(usage.get(procKey(p))!) : 0), 0);
    const sleeping = tools.some((p) => {
      const end = sleepEndsAt(p);
      return end !== null && now < end + SLEEP_GRACE_MS;
    });
    if (
      usage === null ||
      (watchedBefore && previous.signature !== signature) ||
      sleeping ||
      sum((a) => a.cpuPercent) >= TOOL_ACTIVE_CPU_PERCENT ||
      sum((a) => a.ioBytesPerSec) >= TOOL_ACTIVE_IO_BYTES_PER_SEC
    ) {
      activeAt = now;
    }
    const outputAt = await this.outputActivityAt(sessionId, now);
    if (outputAt !== null && outputAt > activeAt) activeAt = Math.min(outputAt, now);
    this.toolWatch.set(key, { signature, activeAt, observedAt: now });
    return activeAt;
  }

  /** Latest write to the session's tool output files (background task output and the like). */
  private async outputActivityAt(sessionId: string, now: number): Promise<number | null> {
    const cached = this.tempDirs.get(sessionId);
    let dir = cached?.dir ?? null;
    if (!cached || (cached.dir === null && now - cached.checkedAt >= MISSING_RECHECK_MS)) {
      dir = null;
      try {
        for (const hash of await readdir(this.tempRoot)) {
          const candidate = path.join(this.tempRoot, hash, sessionId);
          if (await isDirectory(candidate)) {
            dir = candidate;
            break;
          }
        }
      } catch {
        dir = null;
      }
      this.tempDirs.delete(sessionId);
      this.tempDirs.set(sessionId, { dir, checkedAt: now });
      if (this.tempDirs.size > 500) this.tempDirs.delete(this.tempDirs.keys().next().value!);
    }
    // Background task output lives in tasks/; the rest of the folder is not needed.
    return dir ? latestMtimeUnder(path.join(dir, 'tasks'), 0) : null;
  }

  /** Takes a snapshot; if there is no recent one to compare with, takes a second one 2 s later. */
  private async snapshotWithUsage(
    maxAgeMs: number,
    roots: readonly number[],
  ): Promise<{ snapshot: ProcessSnapshot; usage: Map<string, ProcActivity> | null }> {
    let snapshot = await this.options.snapshotter.take(roots);
    let usage = this.sampler.update(snapshot, maxAgeMs);
    if (!usage) {
      await this.sleep(2_000);
      snapshot = await this.options.snapshotter.take(roots);
      usage = this.sampler.update(snapshot, maxAgeMs);
    }
    return { snapshot, usage };
  }
}
