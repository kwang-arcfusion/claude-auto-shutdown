import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Holds ES_CONTINUOUS | ES_SYSTEM_REQUIRED (0x80000001 = 2147483649) on its own thread until
 * stdin closes. The display may still turn off; the system does not go to sleep.
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$api = Add-Type -PassThru -Name ExecutionState -Namespace ClaudeAutoShutdown -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
if ($api::SetThreadExecutionState([uint32]2147483649) -eq 0) { exit 1 }
[Console]::Out.WriteLine('holding')
[void][Console]::In.ReadLine()
`;

/**
 * Keeps Windows out of sleep while armed. Electron's 'prevent-app-suspension' becomes
 * PowerRequestExecutionRequired, which on Modern Standby PCs (S0 low-power idle, like this
 * one) keeps only this app running, not the system awake: Claude could be frozen in standby.
 * The request lives in a helper process; when the app exits or crashes, stdin closes, the
 * helper ends and Windows drops the request, so nothing is ever left behind.
 */
export class KeepAwake {
  private child: ChildProcess | null = null;

  constructor(
    private readonly scriptDir: string,
    private readonly onError: (message: string) => void,
  ) {}

  get active(): boolean {
    return this.child !== null;
  }

  start(): void {
    if (this.child) return;
    let script: string;
    try {
      mkdirSync(this.scriptDir, { recursive: true });
      script = path.join(this.scriptDir, 'keep-awake.ps1');
      writeFileSync(script, SCRIPT, 'utf8');
    } catch (error) {
      this.onError(error instanceof Error ? error.message : String(error));
      return;
    }
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout?.resume();
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString('utf8');
    });
    child.stdin?.on('error', () => {
      // the helper already exited
    });
    child.on('error', (error) => this.onError(error.message));
    child.on('exit', (code) => {
      if (this.child !== child) return; // stopped on purpose
      this.child = null;
      this.onError(`ตัวกันเครื่อง sleep หยุดทำงาน (code ${code ?? '?'}) ${stderr.trim().slice(0, 200)}`.trim());
    });
    this.child = child;
  }

  stop(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.stdin?.end(); // the helper reads EOF, exits, and Windows drops the request
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }, 5_000).unref();
  }
}
