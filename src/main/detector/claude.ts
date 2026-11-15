import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Aggregate, DetectionResult, SessionInfo, Settings, TranscriptState } from '../../shared/types';
import { CpuSampler, procKey, type ProcessSnapshot, type SnapshotSource } from './processes';
import {
  evaluateSession,
  maxOf,
  parseSessionFile,
  type Evaluation,
  type ProcessFacts,
  type SessionActivity,
  type SessionFile,
} from './session';
import { latestMtimeUnder, TranscriptLocator, TranscriptStateCache } from './transcript';
import { classifyDescendants, indexProcesses, processMatchesSession } from './tree';

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
}

export interface ClaudeDetectorOptions {
  claudeDir: () => string;
  snapshotter: SnapshotSource;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
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

/**
 * Decides whether any Claude Code session is still working, from
 * `<claudeDir>/sessions/*.json`, the session transcripts and (when needed) the process tree.
 */
export class ClaudeDetector implements Detector {
  private readonly sampler = new CpuSampler();
  private readonly locator = new TranscriptLocator();
  private readonly transcripts = new TranscriptStateCache();
  private readonly now: () => number;
  private readonly pidAlive: (pid: number) => boolean;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: ClaudeDetectorOptions) {
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
    const activity = await Promise.all(live.map((f) => this.activityFor(projectsDir, f, now)));

    // Cheap pass from files only: one clearly busy session is enough to keep the machine on.
    const cheap = live.map((file, i) => evaluateSession({ file, ...activity[i]!, processes: null, now, settings }));
    const clearlyBusy = cheap.some((e) => e.blocksShutdown && !e.needsProcessCheck);
    const cheapInfos = (): SessionInfo[] => live.map((f, i) => toInfo(f, activity[i]!, cheap[i]!, null));

    if (!detectOptions.forceSnapshot && (clearlyBusy || live.length === 0)) {
      const sessions = cheapInfos();
      return finish(aggregateOf(sessions, fileError), sessions, fileError, false);
    }

    let sample: { snapshot: ProcessSnapshot; cpu: Map<string, number> | null };
    try {
      sample = await this.snapshotWithCpu(settings);
    } catch (error) {
      const sessions = cheapInfos();
      return finish(clearlyBusy ? 'busy' : 'unknown', sessions, (error as Error).message, false);
    }

    const index = indexProcesses(sample.snapshot.procs);
    const sessions: SessionInfo[] = [];
    live.forEach((file, i) => {
      const proc = index.byPid.get(file.pid);
      if (!processMatchesSession(file, proc)) return; // left behind by a process that has exited
      const { tools, helpers } = classifyDescendants(index, proc);
      const cpu = sample.cpu;
      const helperCpuPercent = cpu ? helpers.reduce((sum, p) => sum + (cpu.get(procKey(p)) ?? 0), 0) : null;
      const processes: ProcessFacts = { tools, helperCpuPercent };
      const evaluation = evaluateSession({ file, ...activity[i]!, processes, now, settings });
      sessions.push(toInfo(file, activity[i]!, evaluation, processes));
    });
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

  private async activityFor(projectsDir: string, file: SessionFile, now: number): Promise<SessionActivity> {
    const transcript = await this.locator.locate(projectsDir, file.sessionId, file.cwd, now);
    let transcriptMtime: number | null = null;
    let transcriptState: TranscriptState = 'unknown';
    let sideActivityAt: number | null = null;
    if (transcript) {
      try {
        const info = await stat(transcript);
        transcriptMtime = info.mtimeMs;
        transcriptState = await this.transcripts.get(transcript, info.mtimeMs, info.size);
      } catch {
        // removed between locate and stat
      }
      sideActivityAt = await latestMtimeUnder(path.join(path.dirname(transcript), file.sessionId));
    }
    return {
      transcriptState,
      lastActivityAt: maxOf(transcriptMtime, file.statusUpdatedAt, file.updatedAt),
      sideActivityAt,
    };
  }

  /** Takes a snapshot; if there is no recent one to compare CPU time with, takes a second one 2 s later. */
  private async snapshotWithCpu(settings: Settings): Promise<{ snapshot: ProcessSnapshot; cpu: Map<string, number> | null }> {
    const maxAgeMs = Math.max(3 * settings.pollIntervalSec * 1000, 120_000);
    let snapshot = await this.options.snapshotter.take();
    let cpu = this.sampler.update(snapshot, maxAgeMs);
    if (!cpu) {
      await this.sleep(2_000);
      snapshot = await this.options.snapshotter.take();
      cpu = this.sampler.update(snapshot, maxAgeMs);
    }
    return { snapshot, cpu };
  }
}
