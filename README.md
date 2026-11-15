# Claude Auto Shutdown

Shuts Windows down automatically once Claude Code (in the Claude desktop app or the CLI) has finished working.

## Usage

1. Double-click **Claude Auto Shutdown** on the Desktop (or open `release\Claude Auto Shutdown-win32-x64\Claude Auto Shutdown.exe`).
2. Press **Start watching** before you go to bed and leave the app running. You can close the window: the app keeps watching from the tray.
3. Once Claude has been idle for 5 minutes in a row, the app counts down 5 minutes, checks once more, then runs `shutdown /s /f /t 0`. That is about 10 minutes after the work finishes.

During the countdown, the app cancels by itself if Claude starts working again or someone moves the mouse. Everything is adjustable under **Settings**, including the language: English (the default) or Thai.

## How detection works

- Each session writes `%USERPROFILE%\.claude\sessions\<pid>.json` with the status `busy`, `idle` or `shell`. The app also checks that the session's process is really still running.
- **Waiting for an answer** (a permission prompt, a question, a plan to approve): counts as finished after 5 minutes. The app spots it from a tool call in the transcript that has no result yet while no shell is running.
- **Background commands**: the app waits as long as they show activity (CPU, disk or network I/O, output, new processes). A command that has been quiet for more than 20 minutes counts as stuck, except a timed `sleep N`, which is waited out.
- A **subagent** that is still working, or a **ScheduleWakeup** (for example from `/loop`), keeps the app waiting.
- A session that says `busy` but has been silent for more than 45 minutes, and fits none of the cases above, counts as finished.
- If the status cannot be read, the PC is never shut down.

## Limitations

- Work detached from Claude (`nohup ... &`, `Start-Process`, `docker run -d`) runs outside the session's process tree, so the app cannot see it.
- If Claude runs as administrator but this app does not, command lines may be unreadable. The app then relies on the `shell` status and process creation times.
- Claude in WSL, or with another `CLAUDE_CONFIG_DIR`, is not seen. You can point "Claude folder" in Settings at one folder at a time.
- The app reads Claude Code's internal file formats. After a Claude update, run `npm run detect -- --full` to check they can still be read.
- While watching, the app keeps Windows from sleeping (the screen can still turn off). Closing the lid or pressing the power button still puts the PC to sleep.

## Log

The log is stored in SQLite at `%APPDATA%\Claude Auto Shutdown\logs.sqlite` and kept for 30 days. Older entries are deleted when the app starts and every hour after that.

The table is `events`, with the columns `id, at, level, message, code, params`. `code` and `params` let the window show each entry in the selected language. `message` holds an English copy for reading the file directly.

## Development

```bash
npm install
node node_modules/electron/install.js   # Electron 45 does not download its binary during npm install
npm start            # run the app
npm run start:dry    # run in test mode (never really shuts down)
npm test             # unit tests plus accelerated overnight simulations
npm run e2e          # one full dry-run cycle of the real app
npm run detect       # show what the detector sees right now (--full also inspects processes)
npm run package      # build the .exe folder in release/
npm run shortcut     # create a Desktop shortcut (after package)
```

All user-facing text lives in `src/shared/i18n.ts`, in English and Thai. A test checks that every text exists in both languages with the same parameters.

The icon: `assets/icon.svg` is the favicon. The `.ico` and `.png` files are drawn from the same shape in `src/main/icon.ts` on every `npm run build`.

App flags: `--dry-run` forces test mode, and `--hidden` starts the app hidden in the tray.
