import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildActionCommand } from '../src/main/actions';
import { encodeIco, renderPowerIcon } from '../src/main/icon';
import { loadSettings, saveSettings } from '../src/main/storage';
import { DEFAULT_SETTINGS, formatMinutes, sanitizeSettings } from '../src/shared/settings';

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
});

test('renderPowerIcon produces a PNG of the requested size', () => {
  const png = renderPowerIcon(32, [229, 72, 77]);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 32);
  assert.equal(png.readUInt32BE(20), 32);
});

test('encodeIco writes one directory entry per image', () => {
  const ico = encodeIco([
    { size: 16, png: renderPowerIcon(16, [0, 0, 0]) },
    { size: 256, png: renderPowerIcon(256, [0, 0, 0]) },
  ]);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 2);
  assert.equal(ico.readUInt8(6 + 16), 0); // 256 px is stored as 0
});

test('formatMinutes', () => {
  assert.equal(formatMinutes(10), '10 นาที');
  assert.equal(formatMinutes(0.5), '30 วินาที');
  assert.equal(formatMinutes(2.5), '2.5 นาที');
});
