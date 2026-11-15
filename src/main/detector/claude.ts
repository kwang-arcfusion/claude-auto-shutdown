import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { msg, type Message } from '../../shared/i18n';
import type { Aggregate, DetectionResult, SessionInfo, Settings } from '../../shared/types';
import { ActivitySampler, procKey, type ProcActivity, type ProcInfo, type ProcessSnapshot, type SnapshotSource } from './processes';
import {
  evaluateSession,
  KNOWN_STATUSES,
  maxOf,
  parseSessionFile,
  type Evaluation,
  type ProcessFacts,
  type SessionActivity,
  type SessionFile,
} from './session';
import { nextCronTime } from './cron';
import { emptyTranscriptInfo, latestMtimeUnder, TranscriptInfoCache, TranscriptLocator, type CronJob, type TranscriptInfo } from './transcript';
import { classifyDescendants, filetimeToMs, indexProcesses, sessionIdentity, sleepEndsAt } from './tree';

/** Tool processes count as active at or above this CPU use (% of one core)... */
const TOOL_ACTIVE_CPU_PERCENT = 2;
/** ...or this much I/O (disk or network). */
const TOOL_ACTIVE_IO_BYTES_PER_SEC = 1024;
/** A timed `sleep N` stays active until this long after it should have ended. */
const SLEEP_GRACE_MS = 60_000;
/** Subagent transcripts not written for this long are not read. */
const SUBAGENT_LOOKBACK_MS = 6 * 60 * 60_000;
/** Recurring CronCreate jobs expire this long after they were created (Claude Code 2.1.325: 7 days). */
const CRON_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** A recurring job can fire up to 30 minutes late (Claude Code's jitter); plus 5 minutes of slack. */
const CRON_RECURRING_GRACE_MS = 35 * 60_000;
/** A one-shot job can fire 90 seconds late; plus slack. */
const CRON_ONE_SHOT_GRACE_MS = 5 * 60_000;
/** A job further ahead than this (tomorrow's reminder) is not tonight's work: it does not keep the PC on. */
const CRON_MAX_AHEAD_MS = 6 * 60 * 60_000;
/** Process creation times and file times come from different clocks. */
const CLOCK_SLACK_MS = 2_000;
/** How deep to look in a session's side folder (workflow agents sit three levels down). */
const SIDE_FOLDER_DEPTH = 4;
/** How often to look again for a session's temp folders (one per project folder it used). */
const TEMP_RESCAN_MS = 5 * 60_000;

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
  /**
   * The PC woke up at this time: nothing counts as quiet before it, since time spent asleep is
   * not silence (Claude was frozen too).
   */
  activeSince?: number;
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

function aggregateOf(sessions: readonly SessionInfo[], error: Message | null): Aggregate {
  if (sessions.some((s) => s.blocksShutdown)) return 'busy';
  return error ? 'unknown' : 'idle';
}

/** A sign that Claude Code's files changed format (after an update?): shown, logged, never idle. */
function formatProblem(sessions: readonly SessionInfo[]): Message | null {
  const unknown = sessions.find((s) => s.status !== null && !KNOWN_STATUSES.has(s.status));
  if (unknown) return msg('error.unknownStatus', { status: unknown.status! });
  const unsure = sessions.find((s) => s.reason.code === 'reason.identityUnsure');
  return unsure ? msg('error.identityUnsure', { pid: unsure.pid }) : null;
}

/** What a session scheduled for itself, remembered across checks (the transcript tail moves on). */
interface Remembered {
  timedWaitEndsAt: number | null;
  crons: Map<string, CronJob>;
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
  private readonly remembered = new Map<string, Remembered>();
  private readonly tempDirs = new Map<string, { dirs: string[]; checkedAt: number }>();
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
    const finish = (aggregate: Aggregate, sessions: SessionInfo[], error: Message | null, usedProcessSnapshot: boolean) => ({
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
        ? msg('error.noSessionsDir', { dir: sessionsDir })
        : msg('error.readSessionsDir', { dir: sessionsDir, detail: (error as Error).message });
      return finish('unknown', [], message, false);
    }

    const { files, unreadableLive } = await this.loadSessionFiles(sessionsDir, names);
    const fileError = unreadableLive > 0 ? msg('error.unreadableSessionFiles', { count: unreadableLive }) : null;
    const report = (sessions: SessionInfo[], usedProcessSnapshot: boolean): DetectionResult => {
      const error = fileError ?? formatProblem(sessions);
      return finish(aggregateOf(sessions, error), sessions, error, usedProcessSnapshot);
    };
    const live = files.filter((f) => this.pidAlive(f.pid));
    const now = this.now();
    const projectsDir = path.join(claudeDir, 'projects');

    // No session is open. Before calling that idle, make sure Claude has not just stopped writing
    // status files (after an update): a transcript still mid-turn means it is working.
    if (live.length === 0 && (!detectOptions.skipProcesses || detectOptions.forceSnapshot)) {
      // A file left behind by a crashed session explains its own transcript; only sessions with
      // no file at all count.
      const orphan = await this.transcriptWithoutSession(projectsDir, now, settings, new Set(files.map((f) => f.sessionId)));
      if (orphan !== null) return finish('unknown', [], fileError ?? msg('error.noStatusFile', { session: orphan.slice(0, 8) }), false);
    }
    const activity = await Promise.all(live.map((f) => this.activityFor(projectsDir, f, now, settings, detectOptions.activeSince)));

    // Cheap pass from files only: one clearly busy session is enough to keep the machine on.
    const cheap = live.map((file, i) => evaluateSession({ file, ...activity[i]!, processes: null, now, settings }));
    const clearlyBusy = cheap.some((e) => e.blocksShutdown && !e.needsProcessCheck);
    const cheapInfos = (): SessionInfo[] => live.map((f, i) => toInfo(f, activity[i]!, cheap[i]!, null));

    if (!detectOptions.forceSnapshot && (clearlyBusy || live.length === 0)) return report(cheapInfos(), false);
    if (detectOptions.skipProcesses && !detectOptions.forceSnapshot) {
      // Display-only check: no PowerShell, so an idle verdict here is unverified.
      return { ...report(cheapInfos(), false), partial: true };
    }

    const maxAgeMs = Math.max(3 * settings.pollIntervalSec * 1000, 120_000);
    let sample: { snapshot: ProcessSnapshot; usage: Map<string, ProcActivity> | null };
    try {
      sample = await this.snapshotWithUsage(maxAgeMs, live.map((f) => f.pid));
    } catch (error) {
      const sessions = cheapInfos();
      return finish(clearlyBusy ? 'busy' : 'unknown', sessions, msg('error.snapshot', { detail: (error as Error).message }), false);
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
          reason: msg('reason.identityUnsure'),
          needsProcessCheck: false,
        };
        sessions.push(toInfo(file, activity[i]!, unsure, null));
        continue;
      }
      const tree = classifyDescendants(index, proc);
      const { newestCreatedAt } = tree;
      // Processes started after the turn ended (an async hook, a job a background step left
      // running) are work Claude may still wait for: watch them like commands it started.
      const turnOverAt = file.status === 'idle' || file.status === 'shell' ? (file.statusUpdatedAt ?? null) : null;
      const late = turnOverAt === null ? [] : tree.helpers.filter((p) => p.created > 0 && filetimeToMs(p.created) > turnOverAt + CLOCK_SLACK_MS);
      const tools = late.length > 0 ? [...tree.tools, ...late] : tree.tools;
      const helpers = late.length > 0 ? tree.helpers.filter((p) => !late.includes(p)) : tree.helpers;
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
        toolsActiveAt = await this.toolsActiveAt(key, file.sessionId, tools, usage, checkedAt, maxAgeMs, activity[i]!.timedWaitEndsAt ?? null);
      } else if (file.status === 'shell' && helpers.length > 0) {
        // Claude says a shell is running but none has a known marker: watch everything under it.
        watched.add(`${key}:shell`);
        shellActiveAt = await this.toolsActiveAt(`${key}:shell`, file.sessionId, helpers, usage, checkedAt, maxAgeMs, activity[i]!.timedWaitEndsAt ?? null);
      }
      const processes: ProcessFacts = { tools, helperCpuPercent, toolsActiveAt, newestChildAt: newestCreatedAt, helpersActiveNow, shellActiveAt };
      const evaluation = evaluateSession({ file, ...activity[i]!, processes, now: checkedAt, settings });
      sessions.push(toInfo(file, activity[i]!, evaluation, processes));
    }
    for (const key of this.toolWatch.keys()) if (!watched.has(key)) this.toolWatch.delete(key);
    return report(sessions, true);
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

  private async activityFor(projectsDir: string, file: SessionFile, now: number, settings: Settings, activeSince?: number): Promise<SessionActivity> {
    // A session that moved into a worktree can have copies in several project folders; the most
    // recently written one is where Claude is writing now.
    const copies = await this.locator.locateAll(projectsDir, file.sessionId, file.cwd, now);
    const transcript = copies[0] ?? null;
    let info: TranscriptInfo = emptyTranscriptInfo();
    if (transcript) {
      try {
        info = await this.transcripts.get(transcript.file, transcript.mtimeMs, transcript.size);
      } catch {
        // removed since it was found
      }
    }
    const lastActivityAt = maxOf(transcript?.mtimeMs, file.statusUpdatedAt, file.updatedAt, activeSince);
    const memory = this.remember(file.sessionId, info);
    const schedule = this.cronSchedule(memory.crons.values(), now);

    // The session folder (subagent transcripts, which can number in the hundreds) only matters
    // once the turn is over, or when a busy turn has gone quiet long enough for the silence rule.
    // Skip it while a turn is visibly active, which is most of the night.
    const stalledMs = settings.stalledMinutes * 60_000;
    const quietMs = lastActivityAt === null ? Number.POSITIVE_INFINITY : now - lastActivityAt;
    const needFolder = file.status !== 'busy' || file.waitingFor !== undefined || (stalledMs > 0 && quietMs >= stalledMs);
    // Side folders (subagents, workflows) can sit next to any copy.
    const folder: { latest: number | null; runningSubagentAt: number | null } = { latest: null, runningSubagentAt: null };
    if (needFolder) {
      for (const copy of copies) {
        const found = await this.scanSessionFolder(path.join(path.dirname(copy.file), file.sessionId), now, stalledMs);
        folder.latest = maxOf(folder.latest, found.latest);
        folder.runningSubagentAt = maxOf(folder.runningSubagentAt, found.runningSubagentAt);
      }
    }
    return {
      transcriptState: info.state,
      pendingTools: info.pendingTools,
      scheduledWakeAt: info.scheduledWakeAt,
      lastActivityAt,
      sideActivityAt: folder.latest,
      runningSubagentAt: folder.runningSubagentAt,
      cronNextAt: schedule?.nextAt ?? null,
      cronUntil: schedule?.until ?? null,
      timedWaitEndsAt: memory.timedWaitEndsAt,
    };
  }

  /**
   * Keeps what a session scheduled (timed waits, CronCreate jobs) after it scrolls out of the
   * part of the transcript that is read: a long session can write megabytes after the call.
   */
  private remember(sessionId: string, info: TranscriptInfo): Remembered {
    let memory = this.remembered.get(sessionId);
    if (!memory) {
      memory = { timedWaitEndsAt: null, crons: new Map() };
      this.remembered.set(sessionId, memory);
      if (this.remembered.size > 500) this.remembered.delete(this.remembered.keys().next().value!);
    }
    memory.timedWaitEndsAt = maxOf(memory.timedWaitEndsAt, info.timedWaitEndsAt);
    for (const job of info.crons) memory.crons.set(job.id, job);
    for (const id of info.deletedCrons) memory.crons.delete(id);
    return memory;
  }

  /**
   * The next CronCreate run that should keep the PC on, and until when (runs can start late).
   * Recurring jobs expire after 7 days; a run more than 6 hours ahead does not count.
   */
  private cronSchedule(jobs: Iterable<CronJob>, now: number): { nextAt: number; until: number } | null {
    let nextAt: number | null = null;
    let until = 0;
    for (const job of jobs) {
      if (job.recurring && now > job.createdAt + CRON_MAX_AGE_MS) continue;
      const grace = job.recurring ? CRON_RECURRING_GRACE_MS : CRON_ONE_SHOT_GRACE_MS;
      // A recurring job: the next run, counting one that may still start late. A one-shot job:
      // its only run, after which it deletes itself.
      const run = nextCronTime(job.cron, job.recurring ? now - grace : job.createdAt);
      if (run === null || now > run + grace || run - now > CRON_MAX_AHEAD_MS) continue;
      nextAt = nextAt === null ? run : Math.min(nextAt, run);
      until = Math.max(until, run + grace);
    }
    return nextAt === null ? null : { nextAt, until };
  }

  /**
   * One pass over the session's side folder: its latest write, and the newest subagent
   * transcript that is still mid-turn. Subagents live in subagents/agent-*.jsonl, workflow
   * agents in subagents/workflows/<run>/agent-*.jsonl (plus journal.jsonl); a workflow's
   * workflows/<run>.json appears only when it ends. tool-results/ is skipped (written during
   * tool calls, when the session is busy anyway). Only subagents recent enough to matter are read.
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
    // Deep enough for workflow agents: <session>/subagents/workflows/<run>/agent-*.jsonl.
    await walk(dir, SIDE_FOLDER_DEPTH, false);

    const window = stalledMs > 0 ? Math.min(stalledMs, SUBAGENT_LOOKBACK_MS) : SUBAGENT_LOOKBACK_MS;
    const recent = subagents.filter((s) => now - s.mtimeMs < window).sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const s of recent) {
      const info = await this.transcripts.get(s.file, s.mtimeMs, s.size);
      if (info.state === 'running') return { latest, runningSubagentAt: s.mtimeMs };
    }
    return { latest, runningSubagentAt: null };
  }

  /**
   * Called when no session file belongs to a running process. A transcript that was written
   * recently, is still mid-turn and has no session file (`known`) means Claude is working
   * without a status file (its format may have changed in an update). Returns that
   * transcript's session id. Spare Claude Code processes the desktop app keeps ready write no
   * transcript, so they never trigger this.
   */
  private async transcriptWithoutSession(
    projectsDir: string,
    now: number,
    settings: Settings,
    known: ReadonlySet<string>,
  ): Promise<string | null> {
    const windowMs = settings.stalledMinutes > 0 ? settings.stalledMinutes * 60_000 : SUBAGENT_LOOKBACK_MS;
    let projects;
    try {
      projects = await readdir(projectsDir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const dir = path.join(projectsDir, project.name);
      let names: string[];
      try {
        names = (await readdir(dir, { withFileTypes: true }))
          .filter((e) => e.isFile() && e.name.endsWith('.jsonl') && !known.has(e.name.slice(0, -'.jsonl'.length)))
          .map((e) => e.name);
      } catch {
        continue;
      }
      const recent = await Promise.all(
        names.map(async (name) => {
          try {
            const stats = await stat(path.join(dir, name));
            return now - stats.mtimeMs < windowMs ? { name, mtimeMs: stats.mtimeMs, size: stats.size } : null;
          } catch {
            return null; // removed meanwhile
          }
        }),
      );
      for (const file of recent) {
        if (!file) continue;
        try {
          const info = await this.transcripts.get(path.join(dir, file.name), file.mtimeMs, file.size);
          if (info.state === 'running') return file.name.slice(0, -'.jsonl'.length);
        } catch {
          // removed meanwhile
        }
      }
    }
    return null;
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
    timedWaitEndsAt: number | null = null,
  ): Promise<number> {
    const signature = tools
      .map(procKey)
      .sort()
      .join('|');
    const previous = this.toolWatch.get(key);
    const watchedBefore = previous !== undefined && now - previous.observedAt <= maxAgeMs;
    let activeAt = watchedBefore ? previous.activeAt : now;
    const sum = (pick: (a: ProcActivity) => number): number => tools.reduce((total, p) => total + (usage?.get(procKey(p)) ? pick(usage.get(procKey(p))!) : 0), 0);
    // A deliberate wait: a running `sleep N` process, or a command whose text waits
    // (PowerShell's Start-Sleep runs inside powershell.exe, so only the command shows it).
    const sleeping =
      (timedWaitEndsAt !== null && now < timedWaitEndsAt + SLEEP_GRACE_MS) ||
      tools.some((p) => {
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

  /**
   * Latest write to the session's tool output files (background task output and the like).
   * The temp folder is per project, so a session that moved into a worktree has one per
   * location: all of them count.
   */
  private async outputActivityAt(sessionId: string, now: number): Promise<number | null> {
    let cached = this.tempDirs.get(sessionId);
    if (!cached || now - cached.checkedAt >= TEMP_RESCAN_MS) {
      const dirs: string[] = [];
      try {
        for (const hash of await readdir(this.tempRoot)) {
          const candidate = path.join(this.tempRoot, hash, sessionId);
          if (await isDirectory(candidate)) dirs.push(candidate);
        }
      } catch {
        // no temp folder yet
      }
      cached = { dirs, checkedAt: now };
      this.tempDirs.delete(sessionId);
      this.tempDirs.set(sessionId, cached);
      if (this.tempDirs.size > 500) this.tempDirs.delete(this.tempDirs.keys().next().value!);
    }
    // Background task output lives in tasks/; the rest of the folder is not needed.
    let latest: number | null = null;
    for (const dir of cached.dirs) latest = maxOf(latest, await latestMtimeUnder(path.join(dir, 'tasks'), 0));
    return latest;
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
