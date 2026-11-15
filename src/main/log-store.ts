import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { LogEntry, LogLevel } from '../shared/types';

export const LOG_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const LEVELS: readonly LogLevel[] = ['info', 'warn', 'error'];

/**
 * Event log in SQLite (`events` table). Entries older than the retention window are
 * deleted when the store opens and whenever prune() runs.
 */
export class LogStore {
  private readonly db: DatabaseSync;
  private readonly insertStatement: StatementSync;
  private readonly pruneStatement: StatementSync;
  private readonly recentStatement: StatementSync;

  constructor(
    file: string,
    private readonly retentionDays = LOG_RETENTION_DAYS,
    private readonly now: () => number = Date.now,
  ) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        at      INTEGER NOT NULL,
        level   TEXT    NOT NULL,
        message TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_at ON events (at);
    `);
    this.insertStatement = this.db.prepare('INSERT INTO events (at, level, message) VALUES (?, ?, ?)');
    this.pruneStatement = this.db.prepare('DELETE FROM events WHERE at < ?');
    this.recentStatement = this.db.prepare('SELECT at, level, message FROM events ORDER BY at DESC, id DESC LIMIT ?');
    this.prune();
  }

  append(entry: LogEntry): void {
    try {
      this.insertStatement.run(entry.at, entry.level, entry.message);
    } catch {
      // logging must never break the app
    }
  }

  /** Deletes entries older than the retention window. Returns how many were deleted. */
  prune(): number {
    try {
      const cutoff = this.now() - this.retentionDays * DAY_MS;
      return Number(this.pruneStatement.run(cutoff).changes);
    } catch {
      return 0;
    }
  }

  /** The newest `limit` entries, oldest first. */
  recent(limit: number): LogEntry[] {
    const rows = this.recentStatement.all(limit) as Array<{ at: number; level: string; message: string }>;
    return rows.reverse().map((row) => ({
      at: Number(row.at),
      level: LEVELS.includes(row.level as LogLevel) ? (row.level as LogLevel) : 'info',
      message: String(row.message),
    }));
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    return Number(row.n);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
}

/** Opens the store, or reports why it could not be opened (the app keeps running without it). */
export function openLogStore(file: string): { store: LogStore | null; error: string | null } {
  try {
    return { store: new LogStore(file), error: null };
  } catch (error) {
    return { store: null, error: error instanceof Error ? error.message : String(error) };
  }
}
