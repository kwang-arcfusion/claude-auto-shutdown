import type { ActionKind } from './types';

export type Language = 'en' | 'th';
export const LANGUAGES: readonly Language[] = ['en', 'th'];

export type MessageParams = Record<string, string | number>;

/**
 * Every user-visible text, keyed by code. Templates take {name} placeholders; a type after a
 * bar formats the value: {n|minutes}, {ms|duration}, {at|time}, {action|action},
 * {action|actionIng} and {what|what} (a nested "what.<value>" text).
 */
const EN = {
  // ---- app, tray, notifications
  'app.started': 'App started',
  'app.startedDryRun': 'App started (test mode forced by --dry-run)',
  'app.logDbFailed': 'Could not open the log database: {detail}',
  'app.oldLogFailed': 'Could not read old log entries: {detail}',
  'app.unexpectedError': 'Unexpected error: {detail}',
  'app.checkFailed': 'Check failed: {detail}',
  'app.windowLoadFailed': 'Could not open the window: {detail}',
  'app.startupFailed': 'Start-up failed: {detail}',
  'app.captureFailed': 'Screenshot failed: {detail}',
  'app.windowCrashed': 'The window stopped working ({reason})',
  'app.suspending': 'The PC is going to sleep',
  'app.keepAwakeFailed': 'The keep-awake helper stopped: {detail}',
  'tray.open': 'Open',
  'tray.arm': 'Start watching',
  'tray.stop': 'Stop watching',
  'tray.cancel': 'Cancel shutdown',
  'tray.checkNow': 'Check now',
  'tray.quit': 'Quit',
  'tray.tip.disarmed': 'Not watching',
  'tray.tip.monitoring': 'Watching Claude',
  'tray.tip.confirming': 'Claude is idle, confirming',
  'tray.tip.countdown': 'Counting down to shutdown',
  'tray.tip.executing': 'Shutting down',
  'notify.tray.title': 'Still watching in the background',
  'notify.trayIdle.title': 'Running in the background',
  'notify.tray.body': 'Open it again from the ^ arrow next to the clock. To quit, right-click its icon and choose Quit.',
  'notify.countdown.title': 'Shutdown countdown started',
  'notify.countdownCancelled.title': 'Countdown cancelled',
  'notify.cancelled.title': 'Shutdown cancelled',
  'notify.userActivity.body': 'Someone is using the PC, so watching has stopped',
  'notify.dryRun.title': 'Test mode: time to shut down',
  'notify.dryRun.body': 'The real command would be: {command}',
  'notify.actionFailed.title': 'Shutdown command failed',
  'notify.actionFailed.body': '{detail}',

  // ---- event log
  'log.armed': 'Watching: once Claude is idle for {idle|minutes}, count down {countdown|minutes}, then {action|action}',
  'log.armedDryRun': 'Watching (test mode): once Claude is idle for {idle|minutes}, count down {countdown|minutes}, then {action|action}',
  'log.idleStarted': 'Claude is idle; confirming',
  'log.noSessions': 'No open Claude session found; confirming',
  'log.busyAgain': 'Claude is working again; confirmation restarted',
  'log.unknownReset': 'Status unknown; confirmation restarted',
  'log.countdownStarted': 'Claude has been idle for {idle|minutes}; will {action|action} in {countdown|minutes}',
  'log.countdownCancelledBusy': 'Claude started working during the countdown; countdown cancelled',
  'log.resumedDuringCountdown': 'The PC woke up during the countdown; confirming again',
  'log.resumedConfirmReset': 'The PC just woke up; confirmation restarted',
  'log.tickGap': 'The PC woke up or its clock changed during the countdown; confirming again',
  'log.finalCheckBusy': 'Final check: Claude is still working, so not shutting down',
  'log.lastMomentBusy': 'Claude started working just before shutdown, so not shutting down',
  'log.finalCheckFailedTooOften': 'The final check failed {count} times, so not shutting down',
  'log.finalCheckRetry': 'The final check failed; retrying in 15 seconds',
  'log.dryRunAction': '[Test mode] Time is up. The real command would be: {command}',
  'log.actionFailed': '{command} failed: {detail}',
  'log.actionSent': 'Sent {command}',
  'log.settingsSaveFailed': 'Could not save settings (they apply until the app closes): {detail}',
  'stop.user': 'Stopped watching (you pressed Stop)',
  'stop.userCancel': 'Stopped: you cancelled the shutdown',
  'stop.userActivity': 'Stopped: the mouse or keyboard was used during the countdown',
  'stop.watchdog': 'Stopped: the PC was still running 5 minutes after the command',
  'stop.resumed': 'Stopped: the PC woke from sleep or hibernation',
  'stop.dryRunDone': 'Stopped: the test run is complete',
  'stop.actionFailed': 'Stopped: the shutdown command failed',

  // ---- detection errors
  'error.noSessionsDir': 'Folder not found: {dir} (check “Claude folder” in Settings)',
  'error.readSessionsDir': 'Cannot read {dir}: {detail}',
  'error.unreadableSessionFiles': 'Cannot read the status file of {count} open session(s)',
  'error.snapshot': 'Cannot read the process list: {detail}',
  'error.unknownStatus': 'Unknown session status "{status}": not shutting down (Claude Code may have been updated)',
  'error.noStatusFile': 'Session {session} is mid-turn but has no status file: not shutting down (Claude Code may have been updated)',
  'error.identityUnsure': 'Cannot match session {pid} to its process: not shutting down (Claude Code may have been updated)',

  // ---- why a session counts as working or finished
  'reason.tool': 'Running a command ({names})',
  'reason.shellRunning': 'Claude says a shell is still running',
  'reason.checkingPermission': 'Checking whether it is waiting for permission',
  'reason.waiting': 'Waiting for you to {what|what}',
  'reason.waitedTooLong': 'Waited over {ms|duration} for you to {what|what}, so it counts as finished',
  'reason.quietChecking': 'Quiet for {ms|duration}; checking processes to confirm',
  'reason.quietFinished': 'No activity for {ms|duration}, so it counts as finished',
  'reason.working': 'Claude is working',
  'reason.workingNoStatus': 'No status field, and the transcript turn has not ended',
  'reason.scheduled': 'Scheduled to continue at {at|time}',
  'reason.subagent': 'A subagent is still working',
  'reason.sideActivity': 'A subagent or session file was written recently',
  'reason.helperCpu': 'Background processes are using {cpu}% CPU',
  'reason.toolHung': 'Background command idle for {ms|duration}, so it counts as stuck ({names})',
  'reason.shellHung': 'The shell Claude opened has been idle for {ms|duration}, so it counts as stuck',
  'reason.idle': 'Idle',
  'reason.idleUnchecked': 'Idle (background processes not checked)',
  'reason.identityUnsure': 'Cannot confirm this process belongs to the session, so not shutting down',
  'reason.unknownStatus': 'Unknown status "{status}", counted as working',
  'reason.stoppedByError': 'Stopped by an error: {detail}',
  'what.question': 'answer a question',
  'what.input': 'provide input',
  'what.plan': 'approve a plan',
  'what.permission': 'allow {tool}',
  'what.permissionAny': 'allow a tool',
  'what.worker': 'answer a worker request',
  'what.dialog': 'answer an open dialog',
  'what.sandbox': 'allow a sandbox request',
  'what.goal': 'approve a goal',
  'what.other': 'respond ({value})',

  // ---- window
  'ui.test': 'Test',
  'ui.testTip': 'Test mode: the PC is not really shut down',
  'ui.notWatching': 'Not watching',
  'ui.flow': 'Idle {idle|minutes} → count down {countdown|minutes} → {action|action}',
  'ui.start': 'Start watching',
  'ui.stop': 'Stop watching',
  'ui.cancel': 'Cancel',
  'ui.claudeIdle': 'Claude is idle',
  'ui.confirming': 'Confirming before the countdown',
  'ui.watching': 'Watching',
  'ui.statusUnknown': 'Cannot read status',
  'ui.claudeWorking': 'Claude is working in {count} session(s)',
  'ui.checking': 'Checking…',
  'ui.actingIn': '{action|actionIng} in',
  'ui.finalCheck': 'Final check…',
  'ui.testTimeUp': 'Test: time is up',
  'ui.acting': '{action|actionIng}…',
  'ui.sessions': 'Sessions',
  'ui.checkNow': 'Check now',
  'ui.lastCheckAt': 'Last checked {at|time}',
  'ui.nextCheckIn': 'Next check in {left}',
  'ui.noSessions': 'No open sessions',
  'ui.lastActive': 'Last active {ago}',
  'ui.settings': 'Settings',
  'ui.saved': 'Saved',
  'ui.language': 'Language',
  'ui.advanced': 'Advanced',
  'ui.reset': 'Reset to defaults',
  'ui.command': 'Command: {command}',
  'ui.dryForced': 'Forced on by --dry-run',
  'ui.log': 'Log',
  'ui.logDays': '7 days',
  'ui.logDaysTip': 'Kept in SQLite for 7 days',
  'ui.openFolder': 'Open folder',
  'ui.noPreload': 'Preload API not found',
  'unit.sec': 'sec',
  'unit.min': 'min',
  'set.poll': 'Check every',
  'set.pollTip': 'How often Claude is checked',
  'set.idle': 'Idle for',
  'set.idleTip': 'Claude must stay idle this long before the countdown starts',
  'set.countdown': 'Countdown',
  'set.countdownTip': 'Countdown before shutting down (a real shutdown always gets at least 1 minute)',
  'set.waiting': 'Max wait for an answer',
  'set.waitingTip': 'If Claude asks for permission or asks a question and nobody answers for this long, it counts as finished · 0 = off',
  'set.toolStall': 'Max stuck background',
  'set.toolStallTip': 'A background command with no CPU, disk/network or output activity for this long counts as stuck · 0 = off',
  'set.stalled': 'Max silence',
  'set.stalledTip': 'A session that says it is working but shows no activity for this long counts as finished · 0 = off',
  'set.action': 'When time is up',
  'set.force': 'Force-close other apps',
  'set.forceTip': 'Also close apps with unsaved work (/f); otherwise Windows may wait at a prompt all night',
  'set.cancelOnActivity': 'Cancel if someone uses the PC',
  'set.cancelOnActivityTip': 'Moving the mouse or pressing a key during the countdown cancels it',
  'set.preventSleep': 'Keep the PC awake',
  'set.preventSleepTip': 'Keeps Windows from sleeping while watching (the screen can still turn off)',
  'set.dryRun': 'Test mode',
  'set.dryRunTip': 'Do not really shut down; only log what would happen',
  'set.background': 'Run in background',
  'set.backgroundTip': 'Closing the window keeps the app in the tray (the ^ arrow next to the clock). To quit, right-click its icon and choose Quit.',
  'set.cpu': 'Background CPU',
  'set.cpuTip': 'Combined CPU of the processes under a session that are not Claude commands (e.g. MCP servers) that counts as working',
  'set.claudeDir': 'Claude folder',
  'set.claudeDirTip': 'Leave empty to use the default',
  'action.optShutdown': 'Shut down',
  'action.optHibernate': 'Hibernate',
  'action.optSleep': 'Sleep',
  'verdict.working': 'Working',
  'verdict.tool': 'Running',
  'verdict.background': 'Background',
  'verdict.waiting': 'Waiting',
  'verdict.scheduled': 'Scheduled',
  'verdict.stalled': 'Stuck',
  'verdict.stopped': 'Stopped',
  'verdict.idle': 'Idle',
} as const satisfies Record<string, string>;

export type MessageCode = keyof typeof EN;

const TH: Record<MessageCode, string> = {
  'app.started': 'เปิดโปรแกรม',
  'app.startedDryRun': 'เปิดโปรแกรม (บังคับโหมดทดสอบด้วย --dry-run)',
  'app.logDbFailed': 'เปิดฐานข้อมูล log ไม่ได้: {detail}',
  'app.oldLogFailed': 'อ่าน log เก่าไม่สำเร็จ: {detail}',
  'app.unexpectedError': 'ข้อผิดพลาดที่ไม่คาดคิด: {detail}',
  'app.checkFailed': 'ตรวจสถานะไม่สำเร็จ: {detail}',
  'app.windowLoadFailed': 'เปิดหน้าต่างไม่สำเร็จ: {detail}',
  'app.startupFailed': 'เริ่มโปรแกรมไม่สำเร็จ: {detail}',
  'app.captureFailed': 'ถ่ายภาพหน้าจอไม่สำเร็จ: {detail}',
  'app.windowCrashed': 'หน้าต่างหยุดทำงาน ({reason})',
  'app.suspending': 'เครื่องกำลังเข้าสู่ Sleep',
  'app.keepAwakeFailed': 'ตัวกันเครื่อง sleep หยุดทำงาน: {detail}',
  'tray.open': 'เปิดหน้าต่าง',
  'tray.arm': 'เริ่มเฝ้า',
  'tray.stop': 'หยุดเฝ้า',
  'tray.cancel': 'ยกเลิกการปิดเครื่อง',
  'tray.checkNow': 'ตรวจสถานะเดี๋ยวนี้',
  'tray.quit': 'ออกจากโปรแกรม',
  'tray.tip.disarmed': 'ยังไม่ได้เริ่มเฝ้า',
  'tray.tip.monitoring': 'กำลังเฝ้า Claude',
  'tray.tip.confirming': 'Claude ว่างแล้ว กำลังยืนยัน',
  'tray.tip.countdown': 'กำลังนับถอยหลังก่อนปิดเครื่อง',
  'tray.tip.executing': 'กำลังปิดเครื่อง',
  'notify.tray.title': 'ยังเฝ้าอยู่เบื้องหลัง',
  'notify.trayIdle.title': 'ทำงานอยู่เบื้องหลัง',
  'notify.tray.body': 'เปิดอีกครั้งได้จากลูกศร ^ ข้างนาฬิกา ถ้าจะออก ให้คลิกขวาที่ไอคอนแล้วเลือก "ออกจากโปรแกรม"',
  'notify.countdown.title': 'เริ่มนับถอยหลังก่อนปิดเครื่อง',
  'notify.countdownCancelled.title': 'ยกเลิกการนับถอยหลัง',
  'notify.cancelled.title': 'ยกเลิกการปิดเครื่องแล้ว',
  'notify.userActivity.body': 'ตรวจพบว่ามีคนใช้เครื่องอยู่ จึงหยุดเฝ้า',
  'notify.dryRun.title': 'โหมดทดสอบ: ถึงเวลาปิดเครื่องแล้ว',
  'notify.dryRun.body': 'คำสั่งที่จะใช้จริง: {command}',
  'notify.actionFailed.title': 'สั่งปิดเครื่องไม่สำเร็จ',
  'notify.actionFailed.body': '{detail}',

  'log.armed': 'เริ่มเฝ้า: เมื่อ Claude ว่างต่อเนื่อง {idle|minutes} จะนับถอยหลัง {countdown|minutes} แล้ว{action|action}',
  'log.armedDryRun': 'เริ่มเฝ้า (โหมดทดสอบ): เมื่อ Claude ว่างต่อเนื่อง {idle|minutes} จะนับถอยหลัง {countdown|minutes} แล้ว{action|action}',
  'log.idleStarted': 'Claude ว่างงานแล้ว เริ่มจับเวลายืนยัน',
  'log.noSessions': 'ไม่พบ session ของ Claude ที่เปิดอยู่ เริ่มจับเวลายืนยัน',
  'log.busyAgain': 'Claude กลับมาทำงาน จึงเริ่มจับเวลายืนยันใหม่',
  'log.unknownReset': 'ตรวจสถานะไม่ได้ จึงเริ่มจับเวลายืนยันใหม่',
  'log.countdownStarted': 'Claude ว่างครบ {idle|minutes} แล้ว จะ{action|action}ในอีก {countdown|minutes}',
  'log.countdownCancelledBusy': 'Claude กลับมาทำงานระหว่างนับถอยหลัง จึงยกเลิกการนับ',
  'log.resumedDuringCountdown': 'เครื่องเพิ่งตื่นระหว่างนับถอยหลัง จึงเริ่มยืนยันใหม่',
  'log.resumedConfirmReset': 'เครื่องเพิ่งตื่น จึงเริ่มจับเวลายืนยันใหม่',
  'log.tickGap': 'เครื่องเพิ่งตื่นหรือเวลาเครื่องเปลี่ยนระหว่างนับถอยหลัง จึงเริ่มยืนยันใหม่',
  'log.finalCheckBusy': 'ตรวจซ้ำรอบสุดท้ายพบว่า Claude ยังทำงานอยู่ จึงยังไม่ปิดเครื่อง',
  'log.lastMomentBusy': 'Claude เริ่มทำงานพอดีก่อนปิดเครื่อง จึงยังไม่ปิด',
  'log.finalCheckFailedTooOften': 'ตรวจสถานะรอบสุดท้ายไม่สำเร็จ {count} ครั้ง จึงยังไม่ปิดเครื่อง',
  'log.finalCheckRetry': 'ตรวจสถานะรอบสุดท้ายไม่สำเร็จ จะลองใหม่ใน 15 วินาที',
  'log.dryRunAction': '[โหมดทดสอบ] ถึงเวลาแล้ว คำสั่งที่จะใช้จริงคือ: {command}',
  'log.actionFailed': 'สั่ง {command} ไม่สำเร็จ: {detail}',
  'log.actionSent': 'สั่ง {command} แล้ว',
  'log.settingsSaveFailed': 'บันทึกการตั้งค่าลงไฟล์ไม่สำเร็จ (ใช้ได้จนกว่าจะปิดโปรแกรม): {detail}',
  'stop.user': 'หยุดเฝ้า: ผู้ใช้กดหยุดเฝ้า',
  'stop.userCancel': 'หยุดเฝ้า: ผู้ใช้กดยกเลิกการปิดเครื่อง',
  'stop.userActivity': 'หยุดเฝ้า: มีการใช้เมาส์หรือคีย์บอร์ดระหว่างนับถอยหลัง',
  'stop.watchdog': 'หยุดเฝ้า: สั่งไปแล้วแต่เครื่องยังทำงานอยู่หลัง 5 นาที',
  'stop.resumed': 'หยุดเฝ้า: เครื่องตื่นจาก Sleep/Hibernate',
  'stop.dryRunDone': 'หยุดเฝ้า: โหมดทดสอบทำงานครบรอบแล้ว',
  'stop.actionFailed': 'หยุดเฝ้า: สั่งปิดเครื่องไม่สำเร็จ',

  'error.noSessionsDir': 'ไม่พบโฟลเดอร์ {dir} (ตรวจค่า "โฟลเดอร์ Claude" ในหน้าตั้งค่า)',
  'error.readSessionsDir': 'อ่านโฟลเดอร์ {dir} ไม่ได้: {detail}',
  'error.unreadableSessionFiles': 'อ่านไฟล์สถานะของ session ที่ยังเปิดอยู่ไม่ได้ {count} ไฟล์',
  'error.snapshot': 'อ่านรายการ process ไม่ได้: {detail}',
  'error.unknownStatus': 'ไม่รู้จักสถานะ session "{status}" จึงยังไม่ปิดเครื่อง (Claude Code อาจเพิ่งอัปเดต)',
  'error.noStatusFile': 'session {session} ยังทำงานไม่จบแต่ไม่มีไฟล์สถานะ จึงยังไม่ปิดเครื่อง (Claude Code อาจเพิ่งอัปเดต)',
  'error.identityUnsure': 'จับคู่ session {pid} กับ process ไม่ได้ จึงยังไม่ปิดเครื่อง (Claude Code อาจเพิ่งอัปเดต)',

  'reason.tool': 'กำลังรันคำสั่ง ({names})',
  'reason.shellRunning': 'Claude บอกว่ายังมี shell รันอยู่',
  'reason.checkingPermission': 'กำลังตรวจว่ารอการอนุญาตอยู่หรือไม่',
  'reason.waiting': 'รอผู้ใช้{what|what}',
  'reason.waitedTooLong': 'รอ{what|what}เกิน {ms|duration} จึงนับว่าเสร็จ',
  'reason.quietChecking': 'เงียบมา {ms|duration} กำลังตรวจ process เพื่อยืนยัน',
  'reason.quietFinished': 'ไม่มีความเคลื่อนไหว {ms|duration} จึงนับว่าเสร็จ',
  'reason.working': 'Claude กำลังทำงาน',
  'reason.workingNoStatus': 'ไฟล์สถานะไม่มีฟิลด์ status และ transcript ยังไม่จบ turn',
  'reason.scheduled': 'ตั้งเวลาทำต่อตอน {at|time}',
  'reason.subagent': 'subagent ยังทำงานอยู่',
  'reason.sideActivity': 'มี subagent หรือไฟล์ของ session ถูกเขียนเมื่อไม่นานนี้',
  'reason.helperCpu': 'process เบื้องหลังใช้ CPU {cpu}%',
  'reason.toolHung': 'คำสั่งเบื้องหลังไม่ขยับมา {ms|duration} จึงนับว่าค้าง ({names})',
  'reason.shellHung': 'shell ที่ Claude เปิดไว้ไม่ขยับมา {ms|duration} จึงนับว่าค้าง',
  'reason.idle': 'ว่าง',
  'reason.idleUnchecked': 'ว่าง (ยังไม่ได้ตรวจ process เบื้องหลัง)',
  'reason.identityUnsure': 'ยืนยันไม่ได้ว่า process นี้เป็นของ session นี้ จึงยังไม่ปิดเครื่อง',
  'reason.unknownStatus': 'ไม่รู้จักสถานะ "{status}" จึงถือว่ายังทำงานอยู่',
  'reason.stoppedByError': 'หยุดเพราะเกิดข้อผิดพลาด: {detail}',
  'what.question': 'ตอบคำถาม',
  'what.input': 'ตอบสิ่งที่ถาม',
  'what.plan': 'อนุมัติแผน',
  'what.permission': 'อนุญาตให้ใช้ {tool}',
  'what.permissionAny': 'อนุญาตให้ใช้เครื่องมือ',
  'what.worker': 'ตอบคำขอจาก worker',
  'what.dialog': 'ตอบหน้าต่างที่เปิดค้าง',
  'what.sandbox': 'อนุญาต sandbox',
  'what.goal': 'อนุมัติเป้าหมาย',
  'what.other': 'ตอบ ({value})',

  'ui.test': 'ทดสอบ',
  'ui.testTip': 'โหมดทดสอบ: ไม่ปิดเครื่องจริง',
  'ui.notWatching': 'ยังไม่ได้เริ่มเฝ้า',
  'ui.flow': 'ว่าง {idle|minutes} → นับ {countdown|minutes} → {action|action}',
  'ui.start': 'เริ่มเฝ้า',
  'ui.stop': 'หยุดเฝ้า',
  'ui.cancel': 'ยกเลิก',
  'ui.claudeIdle': 'Claude ว่างแล้ว',
  'ui.confirming': 'ยืนยันก่อนเริ่มนับถอยหลัง',
  'ui.watching': 'กำลังเฝ้า',
  'ui.statusUnknown': 'ตรวจสถานะไม่ได้',
  'ui.claudeWorking': 'Claude ทำงานอยู่ {count} session',
  'ui.checking': 'กำลังตรวจ…',
  'ui.actingIn': 'จะ{action|action}ใน',
  'ui.finalCheck': 'ตรวจซ้ำรอบสุดท้าย…',
  'ui.testTimeUp': 'ทดสอบ: ถึงเวลาแล้ว',
  'ui.acting': '{action|actionIng}…',
  'ui.sessions': 'Session',
  'ui.checkNow': 'ตรวจเดี๋ยวนี้',
  'ui.lastCheckAt': 'ตรวจล่าสุด {at|time}',
  'ui.nextCheckIn': 'ตรวจครั้งถัดไปใน {left}',
  'ui.noSessions': 'ไม่มี session ที่เปิดอยู่',
  'ui.lastActive': 'เคลื่อนไหวล่าสุด {ago}',
  'ui.settings': 'ตั้งค่า',
  'ui.saved': 'บันทึกแล้ว',
  'ui.language': 'ภาษา',
  'ui.advanced': 'ขั้นสูง',
  'ui.reset': 'คืนค่าเริ่มต้น',
  'ui.command': 'คำสั่ง: {command}',
  'ui.dryForced': 'ถูกบังคับเปิดด้วย --dry-run',
  'ui.log': 'บันทึก',
  'ui.logDays': '7 วัน',
  'ui.logDaysTip': 'เก็บไว้ใน SQLite 7 วัน',
  'ui.openFolder': 'เปิดโฟลเดอร์',
  'ui.noPreload': 'ไม่พบ preload API',
  'unit.sec': 'วินาที',
  'unit.min': 'นาที',
  'set.poll': 'ตรวจทุก',
  'set.pollTip': 'ความถี่ในการตรวจสถานะ Claude',
  'set.idle': 'ว่างต่อเนื่อง',
  'set.idleTip': 'Claude ต้องว่างต่อเนื่องนานเท่านี้ก่อนเริ่มนับถอยหลัง',
  'set.countdown': 'นับถอยหลัง',
  'set.countdownTip': 'เวลานับถอยหลังก่อนปิดเครื่อง (การปิดเครื่องจริงได้อย่างน้อย 1 นาทีเสมอ)',
  'set.waiting': 'รอคำตอบนานสุด',
  'set.waitingTip': 'Claude ขออนุญาตหรือถามคำถาม แล้วไม่มีคนตอบนานเท่านี้ จะนับว่าเสร็จ · 0 = ไม่ใช้',
  'set.toolStall': 'background ค้างนานสุด',
  'set.toolStallTip': 'คำสั่งเบื้องหลังที่ยังเปิดอยู่ แต่ไม่ใช้ CPU ไม่อ่าน/เขียนไฟล์หรือเน็ต และไม่มี output นานเท่านี้ จะนับว่าค้าง · 0 = ไม่ใช้',
  'set.stalled': 'เงียบนานสุด',
  'set.stalledTip': 'session ที่ขึ้นว่าทำงานแต่ไม่มีความเคลื่อนไหวเลยนานเท่านี้ จะนับว่าเสร็จ · 0 = ไม่ใช้',
  'set.action': 'เมื่อครบเวลา',
  'set.force': 'บังคับปิดแอปอื่น',
  'set.forceTip': 'ปิดแอปอื่นที่ยังไม่ได้ save ด้วย (/f) ไม่อย่างนั้น Windows อาจค้างที่หน้าถามทั้งคืน',
  'set.cancelOnActivity': 'ยกเลิกเมื่อมีคนใช้เครื่อง',
  'set.cancelOnActivityTip': 'ขยับเมาส์หรือกดคีย์บอร์ดระหว่างนับถอยหลัง = ยกเลิก',
  'set.preventSleep': 'กันเครื่อง sleep',
  'set.preventSleepTip': 'กันไม่ให้ Windows sleep ระหว่างเฝ้า (จอยังดับได้)',
  'set.dryRun': 'โหมดทดสอบ',
  'set.dryRunTip': 'ไม่ปิดเครื่องจริง แค่บันทึกว่าจะสั่งอะไร',
  'set.background': 'ทำงานเบื้องหลัง',
  'set.backgroundTip': 'ปิดหน้าต่างแล้วแอปยังทำงานอยู่ใน tray (ลูกศร ^ ข้างนาฬิกา) ถ้าจะออก ให้คลิกขวาที่ไอคอนแล้วเลือก "ออกจากโปรแกรม"',
  'set.cpu': 'CPU เบื้องหลัง',
  'set.cpuTip': 'CPU รวมของ process ใต้ session ที่ไม่ใช่คำสั่งของ Claude (เช่น MCP server) ที่ถือว่ายังทำงาน',
  'set.claudeDir': 'โฟลเดอร์ Claude',
  'set.claudeDirTip': 'เว้นว่าง = ใช้ค่าอัตโนมัติ',
  'action.optShutdown': 'Shutdown',
  'action.optHibernate': 'Hibernate',
  'action.optSleep': 'Sleep',
  'verdict.working': 'ทำงาน',
  'verdict.tool': 'รันคำสั่ง',
  'verdict.background': 'เบื้องหลัง',
  'verdict.waiting': 'รอตอบ',
  'verdict.scheduled': 'ตั้งเวลาไว้',
  'verdict.stalled': 'ค้าง',
  'verdict.stopped': 'หยุดแล้ว',
  'verdict.idle': 'ว่าง',
};

/** Every language's texts. */
export const MESSAGES: Readonly<Record<Language, Readonly<Record<MessageCode, string>>>> = { en: EN, th: TH };

/** A text to show later, in whatever language is selected then. */
export interface Message {
  code: MessageCode;
  params?: MessageParams;
}

export function msg(code: MessageCode, params?: MessageParams): Message {
  return params ? { code, params } : { code };
}

const UNITS: Record<Language, { sec: string; min: string; hour: string; ago: { now: string; sec: string; min: string; hour: string } }> = {
  en: { sec: 'sec', min: 'min', hour: 'h', ago: { now: 'just now', sec: '{n} s ago', min: '{n} min ago', hour: '{n} h ago' } },
  th: { sec: 'วินาที', min: 'นาที', hour: 'ชม.', ago: { now: 'เมื่อกี้', sec: '{n} วิที่แล้ว', min: '{n} นาทีที่แล้ว', hour: '{n} ชม.ที่แล้ว' } },
};

const ACTION_TEXT: Record<Language, Record<ActionKind, string>> = {
  en: { shutdown: 'shut down', hibernate: 'hibernate', sleep: 'sleep' },
  th: { shutdown: 'ปิดเครื่อง', hibernate: 'Hibernate', sleep: 'Sleep' },
};

const ACTION_ING: Record<Language, Record<ActionKind, string>> = {
  en: { shutdown: 'Shutting down', hibernate: 'Hibernating', sleep: 'Going to sleep' },
  th: { shutdown: 'กำลังปิดเครื่อง', hibernate: 'กำลัง Hibernate', sleep: 'กำลัง Sleep' },
};

export const isLanguage = (value: unknown): value is Language => value === 'en' || value === 'th';

/** "10 min", "30 sec" / "10 นาที", "30 วินาที". */
export function formatMinutes(lang: Language, minutes: number): string {
  const u = UNITS[lang];
  if (minutes > 0 && minutes < 1) return `${Math.round(minutes * 60)} ${u.sec}`;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} ${u.min}`;
}

/** "45 min", "1 h 5 min" / "45 นาที", "1 ชม. 5 นาที". */
export function formatDuration(lang: Language, ms: number): string {
  if (!Number.isFinite(ms)) return lang === 'th' ? 'นานแล้ว' : 'a long time';
  const u = UNITS[lang];
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} ${u.hour} ${minutes % 60} ${u.min}` : `${minutes} ${u.min}`;
}

/** Elapsed time, short: "just now", "45 s ago", "5 min ago", "2 h ago". */
export function formatAgo(lang: Language, elapsedMs: number): string {
  const a = UNITS[lang].ago;
  const seconds = Math.max(0, Math.round(elapsedMs / 1000));
  const minutes = Math.floor(seconds / 60);
  if (seconds < 10) return a.now;
  if (seconds < 60) return a.sec.replace('{n}', String(seconds));
  if (minutes < 60) return a.min.replace('{n}', String(minutes));
  return a.hour.replace('{n}', String(Math.floor(minutes / 60)));
}

export const formatTime = (ms: number): string => {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

function formatValue(lang: Language, value: string | number | undefined, type: string | undefined, params: MessageParams): string {
  // An endless quiet time (no timestamp at all) is Infinity, which JSON turns into null.
  if (type === 'duration') return formatDuration(lang, value === undefined || value === null ? Number.POSITIVE_INFINITY : Number(value));
  if (value === undefined || value === null) return '';
  switch (type) {
    case 'minutes':
      return formatMinutes(lang, Number(value));
    case 'time':
      return formatTime(Number(value));
    case 'action':
      return ACTION_TEXT[lang][value as ActionKind] ?? String(value);
    case 'actionIng':
      return ACTION_ING[lang][value as ActionKind] ?? String(value);
    case 'what':
      return translate(lang, `what.${String(value)}`, params);
    default:
      return String(value);
  }
}

/** Renders a code in a language; unknown codes fall back to English, then to the code itself. */
export function translate(lang: Language, code: string, params: MessageParams = {}): string {
  const template = (MESSAGES[lang] ?? EN)[code as MessageCode] ?? EN[code as MessageCode] ?? code;
  return template.replace(/\{(\w+)(?:\|(\w+))?\}/g, (_match, name: string, type: string | undefined) =>
    formatValue(lang, params[name], type, params),
  );
}

export const render = (lang: Language, message: Message): string => translate(lang, message.code, message.params);

export const isMessageCode = (code: unknown): code is MessageCode => typeof code === 'string' && Object.hasOwn(EN, code);

/** A log entry's text: its code in the selected language, or the plain text an older version saved. */
export function renderEntry(lang: Language, entry: { code?: string; params?: MessageParams; message?: string }): string {
  if (isMessageCode(entry.code)) return translate(lang, entry.code, entry.params);
  return entry.message ?? entry.code ?? '';
}
