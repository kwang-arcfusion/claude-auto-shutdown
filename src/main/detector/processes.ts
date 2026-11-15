import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ProcInfo {
  pid: number;
  ppid: number;
  name: string;
  /** Creation time as a Windows FILETIME (100 ns ticks since 1601). 0 when unknown. */
  created: number;
  /** Kernel + user CPU time in 100 ns ticks. */
  cpuTicks: number;
  cmd: string;
}

export interface ProcessSnapshot {
  /** When the snapshot was taken (ms since the Unix epoch). */
  at: number;
  procs: ProcInfo[];
}

export interface SnapshotSource {
  take(): Promise<ProcessSnapshot>;
}

/**
 * Lists every process with its parent, creation time, CPU time and command line.
 * Windows PowerShell 5.1 is always present; wmic is not (it is gone on this machine).
 */
const SNAPSHOT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
$rows = foreach ($p in Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate,KernelModeTime,UserModeTime,CommandLine) {
  $created = '0'
  if ($p.CreationDate) { $created = $p.CreationDate.ToFileTimeUtc().ToString() }
  [pscustomobject]@{
    p = [int]$p.ProcessId
    pp = [int]$p.ParentProcessId
    n = [string]$p.Name
    c = $created
    t = ([uint64]$p.KernelModeTime + [uint64]$p.UserModeTime).ToString()
    cmd = [string]$p.CommandLine
  }
}
ConvertTo-Json -InputObject @($rows) -Compress -Depth 2
`;

export function parseSnapshotJson(json: string): ProcInfo[] {
  const data: unknown = JSON.parse(json.replace(/^\uFEFF/, ''));
  const rows = Array.isArray(data) ? data : data !== null && typeof data === 'object' ? [data] : [];
  const procs: ProcInfo[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    const pid = Number(row.p);
    if (!Number.isInteger(pid) || pid <= 0) continue; // pid 0 is the System Idle Process
    procs.push({
      pid,
      ppid: Number(row.pp) || 0,
      name: typeof row.n === 'string' ? row.n : '',
      created: Number(row.c) || 0,
      cpuTicks: Number(row.t) || 0,
      cmd: typeof row.cmd === 'string' ? row.cmd : '',
    });
  }
  return procs;
}

export class PowerShellSnapshotter implements SnapshotSource {
  private scriptPath: Promise<string> | null = null;

  constructor(
    private readonly scriptDir: string,
    private readonly timeoutMs = 30_000,
  ) {}

  private ensureScript(): Promise<string> {
    if (!this.scriptPath) {
      this.scriptPath = (async () => {
        await mkdir(this.scriptDir, { recursive: true });
        const file = path.join(this.scriptDir, 'process-snapshot.ps1');
        await writeFile(file, SNAPSHOT_SCRIPT, 'utf8');
        return file;
      })();
      this.scriptPath.catch(() => {
        this.scriptPath = null; // retry on the next call
      });
    }
    return this.scriptPath;
  }

  async take(): Promise<ProcessSnapshot> {
    const script = await this.ensureScript();
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        powershell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { windowsHide: true, timeout: this.timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
        (error, out, errOut) => {
          if (error) {
            const detail = String(errOut ?? '').trim().slice(0, 300);
            reject(new Error(`อ่านรายการ process ไม่ได้: ${error.message}${detail ? ` (${detail})` : ''}`));
          } else {
            resolve(out);
          }
        },
      );
    });
    return { at: Date.now(), procs: parseSnapshotJson(stdout) };
  }
}

export const procKey = (p: ProcInfo): string => `${p.pid}:${p.created}`;

/** Turns successive snapshots into CPU usage per process (% of one core). */
export class CpuSampler {
  private previous: { at: number; ticks: Map<string, number> } | null = null;

  /**
   * Records `snapshot` and returns CPU % per process since the previous snapshot,
   * or null when there is no previous snapshot younger than `maxAgeMs`.
   */
  update(snapshot: ProcessSnapshot, maxAgeMs: number): Map<string, number> | null {
    const ticks = new Map<string, number>();
    for (const p of snapshot.procs) ticks.set(procKey(p), p.cpuTicks);
    const previous = this.previous;
    this.previous = { at: snapshot.at, ticks };
    if (!previous || snapshot.at <= previous.at || snapshot.at - previous.at > maxAgeMs) return null;

    const wallTicks = (snapshot.at - previous.at) * 10_000;
    const usage = new Map<string, number>();
    for (const [key, now] of ticks) {
      const before = previous.ticks.get(key);
      // A process missing from the previous snapshot started inside this window,
      // so all of its CPU time belongs to the window.
      const delta = before === undefined ? now : Math.max(0, now - before);
      usage.set(key, (delta / wallTicks) * 100);
    }
    return usage;
  }
}
