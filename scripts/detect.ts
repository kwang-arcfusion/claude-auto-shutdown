// Prints what the detector currently sees. Usage: npm run detect [-- --full]
import os from 'node:os';
import path from 'node:path';
import { ClaudeDetector, defaultClaudeDir } from '../src/main/detector/claude';
import { PowerShellSnapshotter } from '../src/main/detector/processes';
import { render } from '../src/shared/i18n';
import { DEFAULT_SETTINGS } from '../src/shared/settings';

void (async () => {
  const full = process.argv.includes('--full');
  const detector = new ClaudeDetector({
    claudeDir: () => defaultClaudeDir(),
    snapshotter: new PowerShellSnapshotter(path.join(os.tmpdir(), 'claude-auto-shutdown')),
  });
  const result = await detector.detect({ ...DEFAULT_SETTINGS }, { forceSnapshot: full });
  console.log(
    `aggregate=${result.aggregate} durationMs=${result.durationMs} processSnapshot=${result.usedProcessSnapshot} dir=${result.claudeDir}`,
  );
  if (result.error) console.log(`error: ${render('en', result.error)}`);
  console.table(
    result.sessions.map((s) => ({
      pid: s.pid,
      session: s.sessionId.slice(0, 8),
      status: s.status,
      verdict: s.verdict,
      blocks: s.blocksShutdown,
      transcript: s.transcriptState,
      tools: s.toolProcesses.join(','),
      helperCpu: s.helperCpuPercent === null ? '' : s.helperCpuPercent.toFixed(1),
      lastActivity: s.lastActivityAt ? new Date(s.lastActivityAt).toLocaleTimeString() : '',
    })),
  );
  for (const s of result.sessions) console.log(`${s.pid}: ${render('en', s.reason)}`);
})().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
