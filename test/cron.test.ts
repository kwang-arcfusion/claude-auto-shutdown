import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextCronTime, parseCron } from '../src/main/detector/cron';

/** Local time, like Claude Code's cron jobs. 2026-11-15 is a Sunday. */
const at = (y: number, mo: number, d: number, h: number, mi: number): number => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const from = at(2026, 11, 15, 23, 20);

test('nextCronTime: every N minutes, hourly, daily, lists and steps', () => {
  assert.equal(nextCronTime('*/30 * * * *', from), at(2026, 11, 15, 23, 30));
  assert.equal(nextCronTime('0 * * * *', from), at(2026, 11, 16, 0, 0));
  assert.equal(nextCronTime('0 3 * * *', from), at(2026, 11, 16, 3, 0));
  assert.equal(nextCronTime('15,45 * * * *', from), at(2026, 11, 15, 23, 45));
  assert.equal(nextCronTime('5/20 * * * *', from), at(2026, 11, 15, 23, 25));
  assert.equal(nextCronTime('0-10/5 0 * * *', from), at(2026, 11, 16, 0, 0));
  assert.equal(nextCronTime('20 23 * * *', from), from); // at or after
  assert.equal(nextCronTime('*/30 * * * *', from + 1), at(2026, 11, 15, 23, 30)); // rounds up to the minute
});

test('nextCronTime: weekdays, Sunday as 0 or 7, and either day field may match', () => {
  assert.equal(nextCronTime('30 9 * * 1-5', from), at(2026, 11, 16, 9, 30)); // Monday
  assert.equal(nextCronTime('0 12 * * 0', from), at(2026, 11, 22, 12, 0));
  assert.equal(nextCronTime('0 12 * * 7', from), at(2026, 11, 22, 12, 0));
  assert.equal(nextCronTime('0 12 1 * 1', from), at(2026, 11, 16, 12, 0)); // Monday comes before the 1st
  assert.equal(nextCronTime('0 0 1 12 *', from), null); // 16 days ahead: past the default 8-day horizon
  assert.equal(nextCronTime('0 0 1 12 *', from, 30 * 24 * 60 * 60_000), at(2026, 12, 1, 0, 0));
});

test('unreadable or impossible expressions give null', () => {
  assert.equal(parseCron('every 5 minutes'), null);
  assert.equal(nextCronTime('*/5 * * *', from), null); // four fields
  assert.equal(nextCronTime('61 * * * *', from), null);
  assert.equal(nextCronTime('*/0 * * * *', from), null);
  assert.equal(nextCronTime('0 9 * * MON', from), null); // names are not supported
  assert.equal(nextCronTime('0 0 31 2 *', from), null); // February 31st never comes
});
