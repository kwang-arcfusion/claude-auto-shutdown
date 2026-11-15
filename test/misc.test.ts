import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildActionCommand } from '../src/main/actions';
import { loadSettings, saveSettings } from '../src/main/storage';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/shared/settings';

test('sanitizeSettings clamps numbers and falls back on invalid values', () => {
  const s = sanitizeSettings({
    pollIntervalSec: 1,
    idleConfirmMinutes: -5,
    countdownMinutes: '15',
    stalledMinutes: 'abc',
    action: 'reboot',
    dryRun: 'yes',
    claudeDir: '  D:\\claude  ',
  });
  assert.equal(s.pollIntervalSec, 5);
  assert.equal(s.idleConfirmMinutes, 0);
  assert.equal(s.countdownMinutes, 15);
  assert.equal(s.stalledMinutes, DEFAULT_SETTINGS.stalledMinutes);
  assert.equal(s.action, 'shutdown');
  assert.equal(s.dryRun, false);
  assert.equal(s.claudeDir, 'D:\\claude');
  assert.deepEqual(sanitizeSettings(null), { ...DEFAULT_SETTINGS });
  assert.equal(DEFAULT_SETTINGS.language, 'en');
  assert.equal(sanitizeSettings({ language: 'th' }).language, 'th');
  assert.equal(sanitizeSettings({ language: 'fr' }).language, 'en');
  assert.equal(sanitizeSettings({ language: 'fr' }, { ...DEFAULT_SETTINGS, language: 'th' }).language, 'th');
});

test('a bad value in a patch keeps the current value', () => {
  const current = { ...DEFAULT_SETTINGS, countdownMinutes: 7 };
  assert.equal(sanitizeSettings({ ...current, countdownMinutes: Number.NaN }, current).countdownMinutes, 7);
});

test('settings survive a save and load; a corrupt file gives the defaults', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cas-settings-'));
  const file = path.join(dir, 'settings.json');
  saveSettings(file, { ...DEFAULT_SETTINGS, countdownMinutes: 33, action: 'hibernate' });
  const loaded = loadSettings(file);
  assert.equal(loaded.countdownMinutes, 33);
  assert.equal(loaded.action, 'hibernate');
  writeFileSync(file, '{ not json');
  assert.deepEqual(loadSettings(file), { ...DEFAULT_SETTINGS });
});

test('the shutdown command forces apps closed only when asked', () => {
  const forced = buildActionCommand('shutdown', true, 'C:\\Windows');
  assert.equal(forced.file, 'C:\\Windows\\System32\\shutdown.exe');
  assert.deepEqual(forced.args, ['/s', '/f', '/t', '0']);
  assert.equal(forced.display, 'shutdown /s /f /t 0');
  assert.deepEqual(buildActionCommand('shutdown', false, 'C:\\Windows').args, ['/s', '/t', '0']);
  assert.deepEqual(buildActionCommand('hibernate', true, 'C:\\Windows').args, ['/h']);
  const sleep = buildActionCommand('sleep', true, 'C:\\Windows');
  assert.match(sleep.file, /powershell\.exe$/i);
  assert.match(sleep.args.join(' '), /SetSuspendState/);
  assert.match(sleep.args.join(' '), /exit 1/); // a failed sleep must not look like success
});
