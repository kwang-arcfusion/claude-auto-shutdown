import { isLanguage } from './i18n';
import type { ActionKind, Settings } from './types';

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  pollIntervalSec: 30,
  idleConfirmMinutes: 5,
  countdownMinutes: 5,
  waitingMinutes: 5,
  toolStallMinutes: 20,
  stalledMinutes: 45,
  action: 'shutdown',
  forceCloseApps: true,
  dryRun: false,
  cancelOnUserActivity: true,
  preventSleepWhileArmed: true,
  backgroundCpuPercent: 5,
  claudeDir: '',
  language: 'en',
  runInBackground: true,
});

export const LIMITS = {
  pollIntervalSec: { min: 5, max: 3600 },
  idleConfirmMinutes: { min: 0, max: 720 },
  countdownMinutes: { min: 0, max: 720 },
  waitingMinutes: { min: 0, max: 720 },
  toolStallMinutes: { min: 0, max: 1440 },
  stalledMinutes: { min: 0, max: 1440 },
  backgroundCpuPercent: { min: 0.5, max: 100 },
} as const;

export const ACTIONS: readonly ActionKind[] = ['shutdown', 'hibernate', 'sleep'];

function clampNumber(value: unknown, fallback: number, range: { min: number; max: number }): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(range.max, Math.max(range.min, n));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Returns a valid Settings object. Fields that are missing or invalid in `raw`
 * fall back to `base`, so a bad patch never corrupts the current settings.
 */
export function sanitizeSettings(raw: unknown, base: Readonly<Settings> = DEFAULT_SETTINGS): Settings {
  const r = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    pollIntervalSec: Math.round(clampNumber(r.pollIntervalSec, base.pollIntervalSec, LIMITS.pollIntervalSec)),
    idleConfirmMinutes: clampNumber(r.idleConfirmMinutes, base.idleConfirmMinutes, LIMITS.idleConfirmMinutes),
    countdownMinutes: clampNumber(r.countdownMinutes, base.countdownMinutes, LIMITS.countdownMinutes),
    waitingMinutes: clampNumber(r.waitingMinutes, base.waitingMinutes, LIMITS.waitingMinutes),
    toolStallMinutes: clampNumber(r.toolStallMinutes, base.toolStallMinutes, LIMITS.toolStallMinutes),
    stalledMinutes: clampNumber(r.stalledMinutes, base.stalledMinutes, LIMITS.stalledMinutes),
    action: ACTIONS.includes(r.action as ActionKind) ? (r.action as ActionKind) : base.action,
    forceCloseApps: bool(r.forceCloseApps, base.forceCloseApps),
    dryRun: bool(r.dryRun, base.dryRun),
    cancelOnUserActivity: bool(r.cancelOnUserActivity, base.cancelOnUserActivity),
    preventSleepWhileArmed: bool(r.preventSleepWhileArmed, base.preventSleepWhileArmed),
    backgroundCpuPercent: clampNumber(r.backgroundCpuPercent, base.backgroundCpuPercent, LIMITS.backgroundCpuPercent),
    claudeDir: typeof r.claudeDir === 'string' ? r.claudeDir.trim() : base.claudeDir,
    language: isLanguage(r.language) ? r.language : base.language,
    runInBackground: bool(r.runInBackground, base.runInBackground),
  };
}
