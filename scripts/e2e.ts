// End-to-end check of the real Electron app, in dry-run mode with a fake "idle" detector:
// it arms on start, counts down 6 seconds, runs the final check and logs the command it
// would have run. Nothing is ever shut down: --fake-detector only works with --dry-run.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

void (async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cas-e2e-'));
  writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ pollIntervalSec: 5, idleConfirmMinutes: 0, countdownMinutes: 0.1, cancelOnUserActivity: false, dryRun: true }),
  );
  const electron = require('electron') as unknown as string;
  const screenshot = path.join(dir, 'countdown.png');
  const child = spawn(
    electron,
    ['.', '--dry-run', `--user-data=${dir}`, '--fake-detector=idle', '--auto-arm', `--capture=${screenshot}`, '--capture-delay=2500', '--exit-after=14000'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.resume();
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));

  const summaryLine = stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('{'))
    .pop();
  const summary = summaryLine ? (JSON.parse(summaryLine) as { phase: string }) : null;
  // The app writes its event log to SQLite; read it back to prove it was persisted.
  const dbFile = path.join(dir, 'logs.sqlite');
  let messages: string[] = [];
  let dryRunLogged = false;
  if (existsSync(dbFile)) {
    const db = new DatabaseSync(dbFile);
    const rows = db.prepare('SELECT at, level, message, code FROM events ORDER BY id').all() as Array<{ at: number; level: string; message: string; code: string | null }>;
    messages = rows.map((row) => `${new Date(row.at).toISOString()} [${row.level}] ${row.message}`);
    dryRunLogged = rows.some((row) => row.code === 'log.dryRunAction' && row.message.includes('[Test mode]'));
    db.close();
  }
  const passed =
    code === 0 && summary?.phase === 'disarmed' && dryRunLogged && existsSync(screenshot);

  console.log(messages.join('\n'));
  console.log(`log database: ${dbFile}`);
  console.log(`screenshot: ${screenshot}`);
  console.log(passed ? 'E2E PASSED' : `E2E FAILED (exit ${code}, phase ${summary?.phase ?? 'none'})`);
  process.exit(passed ? 0 : 1);
})();
