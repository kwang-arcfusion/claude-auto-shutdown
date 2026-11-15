import type { Api } from '../shared/api';
import { ACTION_LABEL, formatMinutes } from '../shared/settings';
import type { AppState, LogEntry, SessionInfo, SessionVerdict, Settings } from '../shared/types';

const api = (window as unknown as { api?: Api }).api;

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
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
  lastCheck: byId('lastCheck'),
  pollBtn: byId<HTMLButtonElement>('pollBtn'),
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
const VERDICT: Record<SessionVerdict, { label: string; tone: string }> = {
  working: { label: 'ทำงาน', tone: 'busy' },
  tool: { label: 'รันคำสั่ง', tone: 'busy' },
  background: { label: 'เบื้องหลัง', tone: 'busy' },
  waiting: { label: 'รอตอบ', tone: 'warn' },
  scheduled: { label: 'ตั้งเวลาไว้', tone: 'busy' },
  stalled: { label: 'ค้าง', tone: 'idle' },
  idle: { label: 'ว่าง', tone: 'idle' },
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

let state: AppState | null = null;
let primaryAction: (() => void) | null = null;
let renderedLogKey = '';
let savedTimer: ReturnType<typeof setTimeout> | null = null;

const pad = (n: number): string => String(n).padStart(2, '0');

function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function agoShort(timestamp: number | null): string {
  if (!timestamp) return '';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 10) return 'เมื่อกี้';
  if (seconds < 60) return `${seconds} วิ`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} นาที`;
  return `${Math.floor(minutes / 60)} ชม.`;
}

function timeOf(timestamp: number): string {
  const date = new Date(timestamp);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toDateString() === new Date().toDateString() ? time : `${date.getDate()}/${date.getMonth() + 1} ${time}`;
}

const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? '';

function field<T extends HTMLInputElement | HTMLSelectElement>(name: string): T {
  return ui.form.elements.namedItem(name) as T;
}

function renderHero(s: AppState): void {
  const now = Date.now();
  const action = ACTION_LABEL[s.settings.action];
  let tone = 'off';
  let label = '';
  let sub = '';
  let timer: string | null = null;
  let progress: number | null = null;
  let button: { text: string; kind: string; run: () => void };

  switch (s.phase) {
    case 'disarmed':
      label = 'ยังไม่ได้เริ่มเฝ้า';
      sub = `ว่าง ${formatMinutes(s.settings.idleConfirmMinutes)} → นับ ${formatMinutes(s.settings.countdownMinutes)} → ${action}`;
      button = { text: 'เริ่มเฝ้า', kind: 'primary', run: () => void api?.arm() };
      break;
    case 'monitoring':
      if (s.idleSince !== null) {
        const confirmMs = s.settings.idleConfirmMinutes * 60_000;
        tone = 'confirm';
        label = 'Claude ว่างแล้ว';
        timer = clock(s.idleSince + confirmMs - now);
        progress = confirmMs > 0 ? (now - s.idleSince) / confirmMs : 1;
        sub = 'ยืนยันก่อนเริ่มนับถอยหลัง';
      } else {
        const detection = s.lastDetection;
        const working = detection?.sessions.filter((x) => x.blocksShutdown).length ?? 0;
        tone = 'busy';
        label = 'กำลังเฝ้า';
        sub =
          detection?.aggregate === 'unknown'
            ? 'ตรวจสถานะไม่ได้'
            : working > 0
              ? `Claude ทำงานอยู่ ${working} session`
              : 'กำลังตรวจ…';
      }
      button = { text: 'หยุดเฝ้า', kind: 'ghost', run: () => void api?.disarm() };
      break;
    case 'countdown': {
      const total = s.settings.countdownMinutes * 60_000;
      const left = (s.countdownEndsAt ?? now) - now;
      tone = 'danger';
      label = `จะ${action}ใน`;
      timer = clock(left);
      progress = total > 0 ? 1 - left / total : 1;
      sub = left <= 0 ? 'ตรวจซ้ำรอบสุดท้าย…' : '';
      button = { text: 'ยกเลิก', kind: 'danger', run: () => void api?.cancel() };
      break;
    }
    case 'executing':
      tone = 'danger';
      label = s.effectiveDryRun ? 'ทดสอบ: ถึงเวลาแล้ว' : `กำลัง${action}…`;
      button = { text: 'ยกเลิก', kind: 'ghost', run: () => void api?.cancel() };
      break;
  }

  ui.hero.dataset.tone = tone;
  ui.phaseLabel.textContent = label;
  ui.phaseSub.textContent = sub;
  ui.bigTimer.hidden = timer === null;
  if (timer !== null) ui.bigTimer.textContent = timer;
  ui.progress.hidden = progress === null;
  if (progress !== null) ui.progressBar.style.width = `${Math.min(100, Math.max(0, progress * 100))}%`;
  ui.primaryBtn.textContent = button.text;
  ui.primaryBtn.className = `btn ${button.kind}`;
  primaryAction = button.run;
  ui.dryBadge.hidden = !s.effectiveDryRun;
}

function sessionRow(session: SessionInfo): HTMLLIElement {
  const verdict = VERDICT[session.verdict];
  const row = document.createElement('li');
  row.className = 'session';
  row.dataset.tone = verdict.tone;
  row.title = [session.cwd, session.reason, session.lastActivityAt ? `เคลื่อนไหวล่าสุด ${agoShort(session.lastActivityAt)}ที่แล้ว` : '']
    .filter(Boolean)
    .join('\n');

  const dot = document.createElement('span');
  dot.className = 'dot';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = session.name || basename(session.cwd) || session.sessionId.slice(0, 8);
  const status = document.createElement('span');
  status.className = 'state';
  status.textContent = verdict.label;
  row.append(dot, name, status);
  return row;
}

function renderSessions(s: AppState): void {
  const detection = s.lastDetection;
  ui.lastCheck.textContent = detection ? agoShort(detection.at) : '';
  ui.lastCheck.title = detection ? `ตรวจล่าสุด ${timeOf(detection.at)}` : '';
  ui.detectError.hidden = !detection?.error;
  ui.detectError.textContent = detection?.error ?? '';
  const sessions = detection?.sessions ?? [];
  ui.noSessions.hidden = !detection || sessions.length > 0;
  ui.sessionList.replaceChildren(...sessions.map(sessionRow));
}

function logRow(entry: LogEntry): HTMLLIElement {
  const row = document.createElement('li');
  row.className = entry.level;
  const time = document.createElement('time');
  time.textContent = timeOf(entry.at);
  time.title = new Date(entry.at).toLocaleString('th-TH');
  const message = document.createElement('span');
  message.textContent = entry.message;
  row.append(time, message);
  return row;
}

function renderLog(s: AppState): void {
  const key = `${s.log.length}:${s.log[0]?.at ?? 0}:${s.log[0]?.message ?? ''}`;
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

  const action = field<HTMLSelectElement>('action');
  if (document.activeElement !== action) action.value = s.settings.action;
  action.title = `คำสั่ง: ${s.actionCommand}`;

  const dir = field<HTMLInputElement>('claudeDir');
  if (document.activeElement !== dir) dir.value = s.settings.claudeDir;
  dir.placeholder = s.defaultClaudeDir;

  const dryRun = field<HTMLInputElement>('dryRun');
  dryRun.disabled = s.dryRunForced;
  if (s.dryRunForced) dryRun.checked = true;
  dryRun.closest('.row')?.classList.toggle('disabled', s.dryRunForced);

  const force = field<HTMLInputElement>('forceCloseApps');
  force.disabled = s.settings.action !== 'shutdown';
  force.closest('.row')?.classList.toggle('disabled', force.disabled);
}

function render(): void {
  if (!state) return;
  renderHero(state);
  renderSessions(state);
}

function applyState(next: AppState): void {
  state = next;
  fillSettings(next);
  renderLog(next);
  render();
}

function flashSaved(): void {
  ui.savedNote.hidden = false;
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    ui.savedNote.hidden = true;
  }, 1500);
}

if (!api) {
  ui.phaseLabel.textContent = 'ไม่พบ preload API';
} else {
  const bridge = api;
  void bridge.getState().then(applyState);
  bridge.onState(applyState);
  setInterval(render, 1000);

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
