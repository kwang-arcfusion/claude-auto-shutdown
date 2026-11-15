import type { Api } from '../shared/api';
import { formatAgo, render, renderEntry, translate, type Language, type MessageCode, type MessageParams } from '../shared/i18n';
import type { AppState, LogEntry, SessionInfo, SessionVerdict, Settings } from '../shared/types';

const api = (window as unknown as { api?: Api }).api;

function byId<T extends Element = HTMLElement>(id: string): T {
  const node: Element | null = document.getElementById(id); // also finds SVG elements
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

const ui = {
  dryBadge: byId('dryBadge'),
  hero: byId('hero'),
  phaseLabel: byId('phaseLabel'),
  bigTimer: byId('bigTimer'),
  progress: byId('progress'),
  progressBar: byId('progressBar'),
  phaseSub: byId('phaseSub'),
  primaryBtn: byId<HTMLButtonElement>('primaryBtn'),
  pollBtn: byId<HTMLButtonElement>('pollBtn'),
  pollRing: byId<SVGCircleElement>('pollRing'),
  detectError: byId('detectError'),
  sessionList: byId<HTMLUListElement>('sessionList'),
  noSessions: byId('noSessions'),
  form: byId<HTMLFormElement>('settingsForm'),
  savedNote: byId('savedNote'),
  resetBtn: byId<HTMLButtonElement>('resetBtn'),
  logList: byId<HTMLOListElement>('logList'),
  logFolderBtn: byId<HTMLButtonElement>('logFolderBtn'),
};

/** Short status words; the full reason is in the row's tooltip. */
const VERDICT: Record<SessionVerdict, { code: MessageCode; tone: string }> = {
  working: { code: 'verdict.working', tone: 'busy' },
  tool: { code: 'verdict.tool', tone: 'busy' },
  background: { code: 'verdict.background', tone: 'busy' },
  waiting: { code: 'verdict.waiting', tone: 'warn' },
  scheduled: { code: 'verdict.scheduled', tone: 'busy' },
  stalled: { code: 'verdict.stalled', tone: 'idle' },
  idle: { code: 'verdict.idle', tone: 'idle' },
};

const NUMBER_FIELDS = [
  'pollIntervalSec',
  'idleConfirmMinutes',
  'countdownMinutes',
  'waitingMinutes',
  'toolStallMinutes',
  'stalledMinutes',
  'backgroundCpuPercent',
] as const;
const BOOLEAN_FIELDS = ['forceCloseApps', 'cancelOnUserActivity', 'preventSleepWhileArmed', 'dryRun'] as const;

/** Circumference of the countdown ring (r = 12 in index.html). */
const RING_LENGTH = 2 * Math.PI * 12;

let state: AppState | null = null;
let lang: Language = 'en';
let staticLang: Language | null = null;
let primaryAction: (() => void) | null = null;
let renderedLogKey = '';
let savedTimer: ReturnType<typeof setTimeout> | null = null;

const t = (code: MessageCode, params?: MessageParams): string => translate(lang, code, params);

const pad = (n: number): string => String(n).padStart(2, '0');

function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

const ago = (timestamp: number | null): string => (timestamp ? formatAgo(lang, Date.now() - timestamp) : '');

function timeOf(timestamp: number): string {
  const date = new Date(timestamp);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toDateString() === new Date().toDateString() ? time : `${date.getDate()}/${date.getMonth() + 1} ${time}`;
}

const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? '';

function field<T extends HTMLInputElement | HTMLSelectElement>(name: string): T {
  return ui.form.elements.namedItem(name) as T;
}

/** Fixed texts of the page (data-i18n, data-i18n-title, data-i18n-aria), in the selected language. */
function applyStaticText(): void {
  if (staticLang === lang) return;
  staticLang = lang;
  document.documentElement.lang = lang;
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) node.textContent = t(node.dataset.i18n as MessageCode);
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle as MessageCode);
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-aria]')) {
    node.setAttribute('aria-label', t(node.dataset.i18nAria as MessageCode));
  }
}

function renderHero(s: AppState): void {
  const now = Date.now();
  const action = s.settings.action;
  let tone = 'off';
  let label = '';
  let sub = '';
  let timer: string | null = null;
  let progress: number | null = null;
  let button: { text: string; kind: string; run: () => void } | null;

  switch (s.phase) {
    case 'disarmed':
      label = t('ui.notWatching');
      sub = t('ui.flow', { idle: s.settings.idleConfirmMinutes, countdown: s.settings.countdownMinutes, action });
      button = { text: t('ui.start'), kind: 'primary', run: () => void api?.arm() };
      break;
    case 'monitoring':
      if (s.idleSince !== null) {
        const confirmMs = s.settings.idleConfirmMinutes * 60_000;
        tone = 'confirm';
        label = t('ui.claudeIdle');
        timer = clock(s.idleSince + confirmMs - now);
        progress = confirmMs > 0 ? (now - s.idleSince) / confirmMs : 1;
        sub = t('ui.confirming');
      } else {
        const detection = s.lastDetection;
        const working = detection?.sessions.filter((x) => x.blocksShutdown).length ?? 0;
        tone = 'busy';
        label = t('ui.watching');
        sub =
          detection?.aggregate === 'unknown'
            ? t('ui.statusUnknown')
            : working > 0
              ? t('ui.claudeWorking', { count: working })
              : t('ui.checking');
      }
      button = { text: t('ui.stop'), kind: 'ghost', run: () => void api?.disarm() };
      break;
    case 'countdown': {
      const total = s.countdownTotalMs ?? s.settings.countdownMinutes * 60_000;
      const left = (s.countdownEndsAt ?? now) - now;
      tone = 'danger';
      label = t('ui.actingIn', { action });
      timer = clock(left);
      progress = total > 0 ? 1 - left / total : 1;
      sub = left <= 0 ? t('ui.finalCheck') : '';
      button = { text: t('ui.cancel'), kind: 'danger', run: () => void api?.cancel() };
      break;
    }
    case 'executing':
      // shutdown /t 0 cannot be taken back, so there is nothing to cancel here.
      tone = 'danger';
      label = s.effectiveDryRun ? t('ui.testTimeUp') : t('ui.acting', { action });
      button = null;
      break;
  }

  ui.hero.dataset.tone = tone;
  ui.phaseLabel.textContent = label;
  ui.phaseSub.textContent = sub;
  ui.bigTimer.hidden = timer === null;
  if (timer !== null) ui.bigTimer.textContent = timer;
  ui.progress.hidden = progress === null;
  if (progress !== null) ui.progressBar.style.width = `${Math.min(100, Math.max(0, progress * 100))}%`;
  ui.primaryBtn.hidden = button === null;
  if (button) {
    ui.primaryBtn.textContent = button.text;
    ui.primaryBtn.className = `btn ${button.kind}`;
  }
  primaryAction = button?.run ?? null;
  ui.dryBadge.hidden = !s.effectiveDryRun;
}

function sessionRow(session: SessionInfo): HTMLLIElement {
  const verdict = VERDICT[session.verdict];
  const row = document.createElement('li');
  row.className = 'session';
  row.dataset.tone = verdict.tone;
  row.title = [session.cwd, render(lang, session.reason), session.lastActivityAt ? t('ui.lastActive', { ago: ago(session.lastActivityAt) }) : '']
    .filter(Boolean)
    .join('\n');

  const dot = document.createElement('span');
  dot.className = 'dot';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = session.name || basename(session.cwd) || session.sessionId.slice(0, 8);
  const status = document.createElement('span');
  status.className = 'state';
  status.textContent = t(verdict.code);
  row.append(dot, name, status);
  return row;
}

/** The ring around "check now" empties clockwise until the next check, then refills. */
function renderPollRing(s: AppState): void {
  const left = s.nextPollAt === null ? 0 : Math.max(0, s.nextPollAt - Date.now());
  const total = s.nextPollTotalMs ?? 0;
  const remaining = total > 0 ? Math.min(1, left / total) : 0;
  ui.pollRing.setAttribute('stroke-dashoffset', (-(1 - remaining) * RING_LENGTH).toFixed(2));
  ui.pollRing.classList.toggle('empty', remaining <= 0);
  ui.pollBtn.title = [
    t('ui.checkNow'),
    left > 0 ? t('ui.nextCheckIn', { left: clock(left) }) : t('ui.checking'),
    s.lastDetection ? t('ui.lastCheckAt', { at: s.lastDetection.at }) : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderSessions(s: AppState): void {
  const detection = s.lastDetection;
  ui.detectError.hidden = !detection?.error;
  ui.detectError.textContent = detection?.error ? render(lang, detection.error) : '';
  const sessions = detection?.sessions ?? [];
  ui.noSessions.hidden = !detection || sessions.length > 0;
  ui.sessionList.replaceChildren(...sessions.map(sessionRow));
}

function logRow(entry: LogEntry): HTMLLIElement {
  const row = document.createElement('li');
  row.className = entry.level;
  const time = document.createElement('time');
  time.textContent = timeOf(entry.at);
  time.title = new Date(entry.at).toLocaleString(lang === 'th' ? 'th-TH' : 'en-GB');
  const message = document.createElement('span');
  message.textContent = renderEntry(lang, entry);
  row.append(time, message);
  return row;
}

function renderLog(s: AppState): void {
  const newest = s.log[0];
  const key = `${lang}:${s.log.length}:${newest?.at ?? 0}:${newest?.code ?? newest?.message ?? ''}`;
  if (key === renderedLogKey) return;
  renderedLogKey = key;
  ui.logList.replaceChildren(...s.log.map(logRow));
}

function fillSettings(s: AppState): void {
  for (const key of NUMBER_FIELDS) {
    const input = field<HTMLInputElement>(key);
    if (document.activeElement !== input) input.value = String(s.settings[key]);
  }
  for (const key of BOOLEAN_FIELDS) field<HTMLInputElement>(key).checked = s.settings[key];

  const language = field<HTMLSelectElement>('language');
  if (document.activeElement !== language) language.value = s.settings.language;

  const action = field<HTMLSelectElement>('action');
  if (document.activeElement !== action) action.value = s.settings.action;
  action.title = t('ui.command', { command: s.actionCommand });

  const dir = field<HTMLInputElement>('claudeDir');
  if (document.activeElement !== dir) dir.value = s.settings.claudeDir;
  dir.placeholder = s.defaultClaudeDir;

  const dryRun = field<HTMLInputElement>('dryRun');
  dryRun.disabled = s.dryRunForced;
  if (s.dryRunForced) dryRun.checked = true;
  const dryRow = dryRun.closest<HTMLElement>('.row');
  dryRow?.classList.toggle('disabled', s.dryRunForced);
  if (dryRow) dryRow.title = t(s.dryRunForced ? 'ui.dryForced' : 'set.dryRunTip');

  const force = field<HTMLInputElement>('forceCloseApps');
  force.disabled = s.settings.action !== 'shutdown';
  force.closest('.row')?.classList.toggle('disabled', force.disabled);
}

/** Every second, only what changes with time (timers, the ring); nothing while hidden. */
function tick(): void {
  if (!state || document.hidden) return;
  renderHero(state);
  renderPollRing(state);
}

/** On new state from the main process: everything, including the session list and the log. */
function applyState(next: AppState): void {
  state = next;
  lang = next.settings.language;
  applyStaticText();
  fillSettings(next);
  renderLog(next);
  renderSessions(next);
  renderHero(next);
  renderPollRing(next);
}

function flashSaved(): void {
  ui.savedNote.hidden = false;
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    ui.savedNote.hidden = true;
  }, 1500);
}

if (!api) {
  ui.phaseLabel.textContent = t('ui.noPreload');
} else {
  const bridge = api;
  ui.pollRing.setAttribute('stroke-dasharray', RING_LENGTH.toFixed(2));
  void bridge.getState().then(applyState);
  bridge.onState(applyState);
  setInterval(tick, 1000);
  document.addEventListener('visibilitychange', tick);

  ui.primaryBtn.addEventListener('click', () => primaryAction?.());
  ui.pollBtn.addEventListener('click', () => void bridge.pollNow());
  ui.logFolderBtn.addEventListener('click', () => void bridge.openLogFolder());
  ui.resetBtn.addEventListener('click', () => {
    void bridge.resetSettings().then(flashSaved);
  });
  ui.form.addEventListener('submit', (event) => event.preventDefault());
  ui.form.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) return;
    const key = target.name as keyof Settings;
    if (!key) return;
    let value: unknown;
    if (target instanceof HTMLInputElement && target.type === 'checkbox') value = target.checked;
    else if (target instanceof HTMLInputElement && target.type === 'number') {
      if (target.value === '') return;
      value = Number(target.value);
    } else value = target.value;
    void bridge.updateSettings({ [key]: value } as Partial<Settings>).then(flashSaved);
  });
}
