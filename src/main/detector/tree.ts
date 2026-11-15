import type { ProcInfo } from './processes';

/**
 * Command-line markers of shells that Claude Code starts for its tools, including
 * background tasks. Verified on Claude Code 2.1.325 for Windows:
 *   Bash tool:       bash.exe -c "source ~/.claude/shell-snapshots/snapshot-bash-....sh ..."
 *   PowerShell tool: cmd.exe /d /s /c "... powershell.exe ... $env:CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT ..."
 * MCP servers are also children of the session process but carry neither marker.
 */
export const TOOL_SIGNATURES: readonly RegExp[] = [/shell-snapshots[\\/]/i, /CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT/i];

/** Console hosts attached to console programs; never real work. */
const IGNORED_NAMES = new Set(['conhost.exe']);

export const isToolProcess = (p: ProcInfo): boolean => TOOL_SIGNATURES.some((re) => re.test(p.cmd));

export interface ProcessIndex {
  byPid: Map<number, ProcInfo>;
  children: Map<number, ProcInfo[]>;
}

export function indexProcesses(procs: readonly ProcInfo[]): ProcessIndex {
  const byPid = new Map<number, ProcInfo>();
  const children = new Map<number, ProcInfo[]>();
  for (const p of procs) {
    byPid.set(p.pid, p);
    if (p.ppid === p.pid) continue;
    const siblings = children.get(p.ppid);
    if (siblings) siblings.push(p);
    else children.set(p.ppid, [p]);
  }
  return { byPid, children };
}

export interface Descendants {
  /** Tool shells and everything running under them. */
  tools: ProcInfo[];
  /** Everything else under the session, e.g. MCP servers (or a shell without a known marker). */
  helpers: ProcInfo[];
  /** Newest creation time (ms) among all descendants, console hosts included; null if none. */
  newestCreatedAt: number | null;
}

export function classifyDescendants(index: ProcessIndex, root: ProcInfo): Descendants {
  const tools: ProcInfo[] = [];
  const helpers: ProcInfo[] = [];
  let newestCreatedAt: number | null = null;
  const seen = new Set<number>([root.pid]);
  const stack: Array<{ proc: ProcInfo; inTool: boolean }> = [{ proc: root, inTool: false }];
  while (stack.length > 0) {
    const { proc: parent, inTool } = stack.pop()!;
    for (const child of index.children.get(parent.pid) ?? []) {
      if (seen.has(child.pid)) continue;
      // Windows reuses PIDs: a "child" created before its parent belongs to an older process.
      if (parent.created && child.created && child.created < parent.created) continue;
      seen.add(child.pid);
      if (child.created) {
        const createdMs = filetimeToMs(child.created);
        if (newestCreatedAt === null || createdMs > newestCreatedAt) newestCreatedAt = createdMs;
      }
      if (IGNORED_NAMES.has(child.name.toLowerCase())) continue;
      const tool = inTool || isToolProcess(child);
      (tool ? tools : helpers).push(child);
      stack.push({ proc: child, inTool: tool });
    }
  }
  return { tools, helpers, newestCreatedAt };
}

const FILETIME_UNIX_EPOCH_MS = 11_644_473_600_000;
export const filetimeToMs = (filetime: number): number => filetime / 10_000 - FILETIME_UNIX_EPOCH_MS;
export const msToFiletime = (ms: number): number => (ms + FILETIME_UNIX_EPOCH_MS) * 10_000;

const SLEEP_UNIT_SECONDS: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };
/** Longer waits are trusted only this far, so `sleep 999999` cannot keep the PC on for days. */
export const MAX_TRUSTED_SLEEP_SECONDS = 6 * 3600;

/**
 * When a deliberate wait will end (ms), for `sleep N[smhd]` (Git Bash coreutils) and
 * `timeout /t N` (cmd), capped at MAX_TRUSTED_SLEEP_SECONDS. Null for anything else,
 * including `sleep infinity`.
 */
export function sleepEndsAt(p: ProcInfo): number | null {
  if (!p.created) return null;
  const name = p.name.toLowerCase();
  let seconds: number | null = null;
  if (name === 'sleep.exe') {
    const match = /sleep(?:\.exe)?"?\s+(\d+(?:\.\d+)?)([smhd]?)(?:\s|$)/i.exec(p.cmd);
    if (match) seconds = Number(match[1]) * SLEEP_UNIT_SECONDS[match[2]!.toLowerCase()]!;
  } else if (name === 'timeout.exe') {
    const match = /\/t\s+(\d+)/i.exec(p.cmd);
    if (match) seconds = Number(match[1]);
  }
  if (seconds === null || !Number.isFinite(seconds)) return null;
  return filetimeToMs(p.created) + Math.min(seconds, MAX_TRUSTED_SLEEP_SECONDS) * 1000;
}

/** 2 seconds in FILETIME ticks. */
const PROC_START_TOLERANCE = 20_000_000;

export type Identity = 'match' | 'stale' | 'unsure';

export interface SessionStamps {
  procStart?: string;
  startedAt?: number;
  updatedAt?: number;
  statusUpdatedAt?: number;
}

/**
 * Whether `proc` is the process that wrote the session file. 'stale' needs evidence: the
 * process is gone, or the PID now belongs to a process created after the file was last
 * written (Windows reuses PIDs). A mismatch with no such explanation (e.g. a changed
 * procStart format after a Claude Code update) is 'unsure', never silently 'stale'.
 */
export function sessionIdentity(file: SessionStamps, proc: ProcInfo | undefined): Identity {
  if (!proc) return 'stale';
  if (!proc.created) return 'match'; // creation time unavailable: trust the PID
  const createdMs = filetimeToMs(proc.created);
  const expected = file.procStart !== undefined ? Number(file.procStart) : Number.NaN;
  const hasProcStart = Number.isFinite(expected) && expected > 0;
  if (hasProcStart && Math.abs(expected - proc.created) <= PROC_START_TOLERANCE) return 'match';
  const lastWrite = Math.max(file.updatedAt ?? 0, file.statusUpdatedAt ?? 0, file.startedAt ?? 0);
  if (lastWrite > 0 && createdMs > lastWrite + 5_000) return 'stale';
  // Without procStart: the process can start well before the session (the desktop app keeps
  // spare processes), but never after it.
  if (!hasProcStart && (!file.startedAt || createdMs <= file.startedAt + 5_000)) return 'match';
  return 'unsure';
}

export function processMatchesSession(file: SessionStamps, proc: ProcInfo | undefined): proc is ProcInfo {
  return sessionIdentity(file, proc) === 'match';
}
