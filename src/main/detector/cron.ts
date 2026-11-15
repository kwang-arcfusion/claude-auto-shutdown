/**
 * Just enough of cron for Claude Code's CronCreate jobs (fixed-interval /loop, reminders): five
 * fields (minute hour day-of-month month day-of-week) with numbers, *, ranges, steps and lists,
 * in local time like Claude Code itself. Anything else counts as unreadable (null).
 */

interface Field {
  values: Set<number>;
  /** The field was "*" (matters for the day-of-month / day-of-week rule). */
  any: boolean;
}

const RANGES: ReadonlyArray<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 are Sunday)
];

function parseField(text: string, [min, max]: [number, number]): Field | null {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) return null;
    const step = match[4] !== undefined ? Number(match[4]) : 1;
    let from = min;
    let to = max;
    if (match[1] !== '*') {
      from = Number(match[2]);
      // "5/15" means from 5 to the end, every 15.
      to = match[3] !== undefined ? Number(match[3]) : match[4] !== undefined ? max : from;
    }
    if (!(step >= 1) || from < min || to > max || from > to) return null;
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return { values, any: text === '*' };
}

export function parseCron(expr: string): Field[] | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const fields = parts.map((part, i) => parseField(part, RANGES[i]!));
  if (fields.some((f) => f === null)) return null;
  const dow = fields[4]!;
  if (dow.values.has(7)) dow.values.add(0);
  return fields as Field[];
}

const MINUTE = 60_000;

/**
 * The first time at or after `from` (rounded up to a whole minute) that matches `expr`, or null
 * when the expression cannot be read or nothing matches within `horizonMs`.
 */
export function nextCronTime(expr: string, from: number, horizonMs = 8 * 24 * 60 * MINUTE): number | null {
  const fields = parseCron(expr);
  if (!fields) return null;
  const [minute, hour, dom, month, dow] = fields as [Field, Field, Field, Field, Field];
  const date = new Date(Math.ceil(from / MINUTE) * MINUTE);
  const end = from + horizonMs;
  while (date.getTime() <= end) {
    if (!month.values.has(date.getMonth() + 1)) {
      date.setMonth(date.getMonth() + 1, 1);
      date.setHours(0, 0, 0, 0);
      continue;
    }
    // Standard cron: when both day fields are restricted, either one may match.
    const domOk = dom.values.has(date.getDate());
    const dowOk = dow.values.has(date.getDay());
    const dayOk = dom.any && dow.any ? true : dom.any ? dowOk : dow.any ? domOk : domOk || dowOk;
    if (!dayOk) {
      date.setDate(date.getDate() + 1);
      date.setHours(0, 0, 0, 0);
      continue;
    }
    if (!hour.values.has(date.getHours())) {
      date.setHours(date.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!minute.values.has(date.getMinutes())) {
      date.setMinutes(date.getMinutes() + 1, 0, 0);
      continue;
    }
    return date.getTime();
  }
  return null;
}
