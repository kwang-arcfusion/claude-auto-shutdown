import { execFile } from 'node:child_process';
import path from 'node:path';
import type { ActionKind } from '../shared/types';

export interface ActionCommand {
  file: string;
  args: string[];
  /** Short form shown to the user and written to the log. */
  display: string;
}

const SLEEP_SCRIPT =
  'Add-Type -AssemblyName System.Windows.Forms; ' +
  '[void][System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $false, $false)';

export function buildActionCommand(
  action: ActionKind,
  forceCloseApps: boolean,
  systemRoot: string = process.env.SystemRoot ?? 'C:\\Windows',
): ActionCommand {
  const system32 = path.win32.join(systemRoot, 'System32');
  const shutdownExe = path.win32.join(system32, 'shutdown.exe');
  switch (action) {
    case 'hibernate':
      // Fails when hibernation is turned off (powercfg /hibernate on needs admin).
      return { file: shutdownExe, args: ['/h'], display: 'shutdown /h' };
    case 'sleep':
      // rundll32 powrprof.dll,SetSuspendState hibernates instead when hibernation is on.
      return {
        file: path.win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        args: ['-NoProfile', '-NonInteractive', '-Command', SLEEP_SCRIPT],
        display: 'Sleep (SetSuspendState)',
      };
    case 'shutdown': {
      // Without /f, an app with unsaved work can hold the shutdown open all night.
      const args = forceCloseApps ? ['/s', '/f', '/t', '0'] : ['/s', '/t', '0'];
      return { file: shutdownExe, args, display: `shutdown ${args.join(' ')}` };
    }
  }
}

export function runActionCommand(command: ActionCommand): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    execFile(command.file, command.args, { windowsHide: true, timeout: 60_000 }, (error, _stdout, stderr) => {
      if (!error) {
        resolve({ ok: true });
        return;
      }
      const detail = String(stderr ?? '').trim();
      resolve({ ok: false, error: detail ? `${error.message} (${detail})` : error.message });
    });
  });
}
