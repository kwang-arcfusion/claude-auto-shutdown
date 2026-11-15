import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  shell,
  Tray,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DetectionResult, Phase, Settings } from '../shared/types';
import { buildActionCommand, runActionCommand } from './actions';
import { Controller } from './controller';
import { ClaudeDetector, defaultClaudeDir, resolveClaudeDir, type Detector } from './detector/claude';
import { PowerShellSnapshotter } from './detector/processes';
import { renderPowerIcon, type Rgb } from './icon';
import { openLogStore } from './log-store';
import { loadSettings, saveSettings } from './storage';

// ---- command-line flags ----------------------------------------------------------
const argv = process.argv.slice(1);
const hasFlag = (name: string): boolean => argv.includes(`--${name}`);
const flagValue = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
};

/** Never runs the real action; only logs it. */
const DRY_RUN_FORCED = hasFlag('dry-run');
/** Starts with the window hidden in the tray. */
const START_HIDDEN = hasFlag('hidden');
// Test hooks.
const SMOKE = hasFlag('smoke'); // print one detection as JSON and exit
const CAPTURE_FILE = flagValue('capture'); // save a screenshot of the window
const CAPTURE_DELAY_MS = Number(flagValue('capture-delay') ?? 2500);
const EXIT_AFTER_MS = flagValue('exit-after') !== undefined ? Number(flagValue('exit-after')) : null;
const AUTO_ARM = hasFlag('auto-arm');
const USER_DATA = flagValue('user-data');
const EXPAND = hasFlag('expand'); // open the collapsed sections before capturing
// A fake detector is honoured only together with --dry-run, so it can never shut the machine down.
const FAKE_DETECTOR = DRY_RUN_FORCED ? flagValue('fake-detector') : undefined;
const TEST_MODE = SMOKE || CAPTURE_FILE !== undefined || EXIT_AFTER_MS !== null || FAKE_DETECTOR !== undefined;

if (USER_DATA) app.setPath('userData', path.resolve(USER_DATA));
else if (TEST_MODE) app.setPath('userData', path.join(os.tmpdir(), 'claude-auto-shutdown-test'));

app.setAppUserModelId('local.claude-auto-shutdown');

if (!TEST_MODE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function fakeDetector(mode: string): Detector {
  const busy = mode === 'busy';
  return {
    async detect(): Promise<DetectionResult> {
      const now = Date.now();
      return {
        at: now,
        aggregate: busy ? 'busy' : 'idle',
        error: null,
        claudeDir: '(fake detector)',
        usedProcessSnapshot: false,
        durationMs: 1,
        sessions: [
          {
            pid: 4242,
            sessionId: '00000000-0000-0000-0000-000000000000',
            name: busy ? 'ตัวอย่าง: session ที่กำลังทำงาน' : 'ตัวอย่าง: session ที่ทำงานเสร็จแล้ว',
            cwd: 'C:\\Projects\\demo',
            entrypoint: 'claude-desktop',
            status: busy ? 'busy' : 'idle',
            waitingFor: null,
            verdict: busy ? 'working' : 'idle',
            blocksShutdown: busy,
            reason: busy ? 'Claude กำลังทำงาน' : 'ว่าง',
            lastActivityAt: now - 4 * 60_000,
            transcriptState: busy ? 'running' : 'ended',
            toolProcesses: [],
            helperCpuPercent: 0,
            processesChecked: true,
          },
        ],
      };
    },
  };
}

const TRAY_COLORS: Record<string, Rgb> = {
  disarmed: [120, 126, 135],
  monitoring: [34, 160, 107],
  confirming: [217, 160, 0],
  countdown: [229, 72, 77],
  executing: [160, 30, 40],
};

const TRAY_TEXT: Record<string, string> = {
  disarmed: 'ยังไม่ได้เริ่มเฝ้า',
  monitoring: 'กำลังเฝ้า Claude',
  confirming: 'Claude ว่างแล้ว กำลังยืนยัน',
  countdown: 'กำลังนับถอยหลังก่อนปิดเครื่อง',
  executing: 'กำลังปิดเครื่อง',
};

function main(): void {
  const userData = app.getPath('userData');
  const settingsFile = path.join(userData, 'settings.json');
  const logs = openLogStore(path.join(userData, 'logs.sqlite'));

  let mainWindow: BrowserWindow | null = null;
  let tray: Tray | null = null;
  let quitting = false;
  let blockerId: number | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let trayKey = '';
  let onTop = false;
  let toldAboutTray = false;
  const icons = new Map<string, NativeImage>();

  const detector: Detector = FAKE_DETECTOR
    ? fakeDetector(FAKE_DETECTOR)
    : new ClaudeDetector({
        claudeDir: () => resolveClaudeDir(controller.getSettings()),
        snapshotter: new PowerShellSnapshotter(userData),
      });

  const controller: Controller = new Controller(
    {
      now: Date.now,
      detect: (settings) => detector.detect(settings),
      runAction: async (settings, dryRun) => {
        const command = buildActionCommand(settings.action, settings.forceCloseApps);
        if (dryRun) return { ok: true, command: command.display };
        return { ...(await runActionCommand(command)), command: command.display };
      },
      describeAction: (settings) => buildActionCommand(settings.action, settings.forceCloseApps).display,
      systemIdleSeconds: () => powerMonitor.getSystemIdleTime(),
      setPreventSleep,
      notify,
      saveSettings: (settings) => saveSettings(settingsFile, settings),
      persistLog: (entry) => logs.store?.append(entry),
      onChange: pushState,
      onCountdownStarted: revealForCountdown,
      defaultClaudeDir: defaultClaudeDir(),
    },
    loadSettings(settingsFile),
    DRY_RUN_FORCED,
  );
  if (logs.store) controller.restoreLog(logs.store.recent(100));

  function iconFor(key: string): NativeImage {
    let image = icons.get(key);
    if (!image) {
      const color = TRAY_COLORS[key] ?? TRAY_COLORS.disarmed!;
      image = nativeImage.createFromBuffer(renderPowerIcon(16, color));
      image.addRepresentation({ scaleFactor: 1.5, buffer: renderPowerIcon(24, color) });
      image.addRepresentation({ scaleFactor: 2, buffer: renderPowerIcon(32, color) });
      icons.set(key, image);
    }
    return image;
  }

  function setPreventSleep(on: boolean): void {
    if (on && blockerId === null) {
      blockerId = powerSaveBlocker.start('prevent-app-suspension');
    } else if (!on && blockerId !== null) {
      powerSaveBlocker.stop(blockerId);
      blockerId = null;
    }
  }

  function notify(title: string, body: string): void {
    try {
      if (Notification.isSupported()) new Notification({ title, body, icon: iconFor('countdown') }).show();
    } catch {
      // notifications are best effort
    }
  }

  function pushState(): void {
    const state = controller.state();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('state', state);
      const wantOnTop = state.phase === 'countdown' && !TEST_MODE;
      if (wantOnTop !== onTop) {
        onTop = wantOnTop;
        mainWindow.setAlwaysOnTop(wantOnTop);
      }
    }
    updateTray(state.phase, state.idleSince !== null);
  }

  function updateTray(phase: Phase, confirming: boolean): void {
    if (!tray) return;
    const key = phase === 'monitoring' && confirming ? 'confirming' : phase;
    if (key === trayKey) return;
    trayKey = key;
    tray.setImage(iconFor(key));
    tray.setToolTip(`Claude Auto Shutdown · ${TRAY_TEXT[key] ?? ''}`);
    tray.setContextMenu(buildTrayMenu(phase));
  }

  function buildTrayMenu(phase: Phase): Menu {
    const toggle: MenuItemConstructorOptions =
      phase === 'disarmed'
        ? { label: 'เริ่มเฝ้า', click: arm }
        : phase === 'monitoring'
          ? { label: 'หยุดเฝ้า', click: () => controller.cancel() }
          : { label: 'ยกเลิกการปิดเครื่อง', click: () => controller.cancel() };
    return Menu.buildFromTemplate([
      { label: 'เปิดหน้าต่าง', click: showWindow },
      { type: 'separator' },
      toggle,
      { label: 'ตรวจสถานะเดี๋ยวนี้', click: () => schedulePoll(0) },
      { type: 'separator' },
      {
        label: 'ออกจากโปรแกรม',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]);
  }

  function arm(): void {
    controller.arm();
    schedulePoll(0);
  }

  function schedulePoll(delayMs?: number): void {
    if (pollTimer) clearTimeout(pollTimer);
    let ms = delayMs ?? controller.getSettings().pollIntervalSec * 1000;
    if (controller.getPhase() === 'countdown') ms = Math.min(ms, 15_000);
    controller.setNextPollAt(Date.now() + ms);
    pollTimer = setTimeout(() => {
      pollTimer = null;
      controller.setNextPollAt(null);
      void controller.poll().finally(() => schedulePoll());
    }, ms);
  }

  function createWindow(show: boolean): BrowserWindow {
    const win = new BrowserWindow({
      width: 460,
      height: 680,
      minWidth: 380,
      minHeight: 480,
      show: false,
      title: 'Claude Auto Shutdown',
      icon: iconFor('monitoring'),
      autoHideMenuBar: true,
      backgroundColor: '#0b0d10',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    win.removeMenu();
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.once('ready-to-show', () => {
      if (show) win.show();
    });
    win.on('close', (event) => {
      if (quitting || controller.getPhase() === 'disarmed') return;
      // Closing while armed would silently stop the auto-shutdown, so hide to the tray instead.
      event.preventDefault();
      win.hide();
      if (!toldAboutTray) {
        toldAboutTray = true;
        notify('ยังเฝ้าอยู่ใน tray', 'คลิกไอคอนรูปปุ่ม power ที่มุมจอเพื่อเปิดหน้าต่างอีกครั้ง');
      }
    });
    void win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    return win;
  }

  function showWindow(): void {
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createWindow(true);
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  function revealForCountdown(): void {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (TEST_MODE) {
      mainWindow.showInactive();
      return;
    }
    showWindow();
    mainWindow.flashFrame(true);
  }

  async function capture(file: string): Promise<void> {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.isVisible()) mainWindow.showInactive();
    if (EXPAND) await mainWindow.webContents.executeJavaScript("document.querySelectorAll('details').forEach((d) => { d.open = true; })");
    // Grow the window to the page height so the screenshot shows everything.
    const height = Number(await mainWindow.webContents.executeJavaScript('document.documentElement.scrollHeight'));
    const [width] = mainWindow.getContentSize();
    if (Number.isFinite(height) && width) mainWindow.setContentSize(width, Math.min(Math.max(height, 600), 2400));
    await new Promise((resolve) => setTimeout(resolve, 600));
    const image = await mainWindow.webContents.capturePage();
    writeFileSync(file, image.toPNG());
    process.stdout.write(`captured ${file}\n`);
  }

  // ---- IPC ----------------------------------------------------------------------
  const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
  ipcMain.handle('state:get', () => controller.state());
  ipcMain.handle('arm', () => arm());
  ipcMain.handle('disarm', () => controller.disarm('ผู้ใช้กดหยุดเฝ้า'));
  ipcMain.handle('cancel', () => controller.cancel());
  ipcMain.handle('poll-now', () => schedulePoll(0));
  ipcMain.handle('settings:update', (_event, patch: unknown) => {
    const settings = controller.updateSettings(isRecord(patch) ? (patch as Partial<Settings>) : {});
    schedulePoll(0);
    return settings;
  });
  ipcMain.handle('settings:reset', () => {
    const settings = controller.resetSettings();
    schedulePoll(0);
    return settings;
  });
  ipcMain.handle('open-log-folder', async () => {
    await shell.openPath(userData);
  });

  // ---- lifecycle ------------------------------------------------------------------
  if (SMOKE) {
    app
      .whenReady()
      .then(async () => {
        const result = await detector.detect(controller.getSettings(), { forceSnapshot: true });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        logs.store?.close();
        app.exit(0);
      })
      .catch((error: unknown) => {
        process.stderr.write(`${String(error)}\n`);
        app.exit(1);
      });
    return;
  }

  app.on('second-instance', showWindow);
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => logs.store?.close());

  void app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark'; // the UI is dark only; this also darkens the title bar and native controls
    Menu.setApplicationMenu(null);
    tray = new Tray(iconFor('disarmed'));
    tray.on('click', showWindow);
    updateTray('disarmed', false);
    mainWindow = createWindow(!START_HIDDEN);

    setInterval(() => controller.tick(), 1000);
    setInterval(() => logs.store?.prune(), 60 * 60 * 1000); // keep only the last 30 days
    powerMonitor.on('suspend', () => controller.addLog('info', 'เครื่องกำลังเข้าสู่ Sleep'));
    powerMonitor.on('resume', () => {
      controller.onResume();
      schedulePoll(0);
    });

    controller.addLog('info', `เปิดโปรแกรม${DRY_RUN_FORCED ? ' (บังคับโหมดทดสอบด้วย --dry-run)' : ''}`);
    if (logs.error) controller.addLog('warn', `เปิดฐานข้อมูล log ไม่ได้: ${logs.error}`);
    schedulePoll(0);
    if (AUTO_ARM) arm();
    if (CAPTURE_FILE) setTimeout(() => void capture(CAPTURE_FILE), CAPTURE_DELAY_MS);
    if (EXIT_AFTER_MS !== null) {
      setTimeout(() => {
        const log = controller.state().log.slice().reverse();
        process.stdout.write(`${JSON.stringify({ phase: controller.getPhase(), log })}\n`);
        quitting = true;
        logs.store?.close();
        app.exit(0);
      }, EXIT_AFTER_MS);
    }
  });
}
