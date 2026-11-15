import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  formatAgo,
  formatDuration,
  formatMinutes,
  isMessageCode,
  LANGUAGES,
  MESSAGES,
  msg,
  render,
  renderEntry,
  translate,
  type MessageCode,
} from '../src/shared/i18n';

// Parameter names must match; the formatter may differ (English "Shutting down in", Thai "จะปิดเครื่องใน").
const placeholders = (template: string): string[] => [...new Set([...template.matchAll(/\{(\w+)(?:\|\w+)?\}/g)].map((m) => m[1]!))].sort();

test('every language has every text, with the same parameters as English', () => {
  const codes = Object.keys(MESSAGES.en) as MessageCode[];
  for (const lang of LANGUAGES) {
    assert.deepEqual(Object.keys(MESSAGES[lang]).sort(), [...codes].sort(), lang);
    for (const code of codes) {
      const text = MESSAGES[lang][code];
      assert.ok(text.trim() !== '', `${lang} ${code} is empty`);
      assert.deepEqual(placeholders(text), placeholders(MESSAGES.en[code]), `${lang} ${code}`);
    }
  }
});

test('every text the window, tray and session rules look up by name exists', () => {
  const html = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const keys = [...html.matchAll(/data-i18n(?:-title|-aria)?="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 30);
  for (const key of keys) assert.ok(isMessageCode(key), `index.html: ${key}`);
  for (const phase of ['disarmed', 'monitoring', 'confirming', 'countdown', 'executing']) assert.ok(isMessageCode(`tray.tip.${phase}`), phase);
  for (const what of ['question', 'plan', 'permission', 'dialog', 'sandbox', 'goal', 'other']) assert.ok(isMessageCode(`what.${what}`), what);
});

test('placeholders are filled and formatted per language', () => {
  const armed = { idle: 5, countdown: 0.5, action: 'shutdown' };
  assert.equal(translate('en', 'log.armed', armed), 'Watching: once Claude is idle for 5 min, count down 30 sec, then shut down');
  assert.equal(translate('th', 'log.armed', armed), 'เริ่มเฝ้า: เมื่อ Claude ว่างต่อเนื่อง 5 นาที จะนับถอยหลัง 30 วินาที แล้วปิดเครื่อง');
  assert.equal(translate('en', 'ui.actingIn', { action: 'hibernate' }), 'Hibernating in');
  assert.equal(translate('th', 'ui.actingIn', { action: 'shutdown' }), 'จะปิดเครื่องใน');
  // A nested "what" text shares the params of its parent.
  assert.equal(render('en', msg('reason.waiting', { what: 'permission', tool: 'Bash' })), 'Waiting for you to allow Bash');
  assert.equal(render('th', msg('reason.waiting', { what: 'permission', tool: 'Bash' })), 'รอผู้ใช้อนุญาตให้ใช้ Bash');
  assert.equal(render('en', msg('reason.waiting', { what: 'other', value: 'mystery' })), 'Waiting for you to respond (mystery)');
  // An endless quiet time survives JSON (Infinity becomes null) as "a long time".
  const quiet = JSON.parse(JSON.stringify(msg('reason.quietFinished', { ms: Number.POSITIVE_INFINITY })));
  assert.equal(render('en', quiet), 'No activity for a long time, so it counts as finished');
});

test('formatters', () => {
  assert.equal(formatMinutes('en', 10), '10 min');
  assert.equal(formatMinutes('en', 0.5), '30 sec');
  assert.equal(formatMinutes('th', 2.5), '2.5 นาที');
  assert.equal(formatMinutes('th', 0.25), '15 วินาที');
  assert.equal(formatDuration('en', 45 * 60_000), '45 min');
  assert.equal(formatDuration('en', 65 * 60_000), '1 h 5 min');
  assert.equal(formatDuration('th', 125 * 60_000), '2 ชม. 5 นาที');
  assert.equal(formatAgo('en', 3_000), 'just now');
  assert.equal(formatAgo('en', 45_000), '45 s ago');
  assert.equal(formatAgo('en', 5 * 60_000), '5 min ago');
  assert.equal(formatAgo('th', 2 * 60 * 60_000), '2 ชม.ที่แล้ว');
});

test('unknown codes and old log entries still show something sensible', () => {
  assert.equal(translate('th', 'no.such.code'), 'no.such.code');
  assert.equal(renderEntry('en', { message: 'ข้อความเก่าจากเวอร์ชันก่อน' }), 'ข้อความเก่าจากเวอร์ชันก่อน');
  assert.equal(renderEntry('th', { code: 'renamed.later', message: 'English copy' }), 'English copy');
  assert.equal(renderEntry('th', { code: 'stop.user' }), 'หยุดเฝ้า: ผู้ใช้กดหยุดเฝ้า');
});
