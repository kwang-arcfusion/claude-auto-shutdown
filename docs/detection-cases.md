# Detection cases

How Claude Auto Shutdown decides that Claude Code has finished, case by case, and which test covers each case.

## Sources and overall rule

The facts about Claude Code come from version 2.1.325: its program and real files on Windows. A newer version may change them; see [When Claude Code changes](#when-claude-code-changes).

**The overall rule:** the PC shuts down only after all of these:

- every open session has counted as finished for 5 minutes in a row;
- a 5-minute countdown has run;
- a full check, including processes, passes;
- a last look at the files, right before acting, shows nothing new.

Anything the app cannot read keeps the PC on.

## What the app reads

- **Status file** `%USERPROFILE%\.claude\sessions\<pid>.json`:
  - `status` is one of:
    - `busy`
    - `idle`
    - `waiting`: a permission prompt, question, dialog or MCP input request is open, and `waitingFor` says which.
    - `shell`: the turn is over but a background shell is still running (terminal only).
  - It is written only when the status changes; there is no heartbeat. While background agents or workflows run, the desktop app keeps it `busy` for hours.
- **Transcript** `%USERPROFILE%\.claude\projects\<folder>\<sessionId>.jsonl`. A session can have copies in several folders (for example after moving into a worktree). The most recently written copy is the live one.
- **Side folder** `<sessionId>\` next to the transcript:
  - subagents: `subagents\agent-*.jsonl`
  - workflow agents: `subagents\workflows\<run>\agent-*.jsonl`
- **The session's process tree** (PowerShell, only while watching):
  - commands Claude started, with their CPU and disk/network I/O
  - their output files in `%TEMP%\claude\<hash>\<sessionId>\tasks\`

## Cases

| Case | What the app does | Test |
|---|---|---|
| Claude is answering: status `busy`, transcript growing | Working | overnight: normal night |
| Long thinking with nothing written | Working; finished only after 45 min with no activity at all | overnight: 25 minutes of silent thinking |
| `busy`, but nothing at all for 45 min | Finished (stuck) | session: silence rule tests |
| Long command (build, tests) | Working while it shows CPU, disk/network I/O, output or new processes | overnight: normal night |
| Background command after the turn ends | Working while active; finished after 20 quiet minutes | overnight: busy background task; dev server |
| Timed wait: `sleep 600`, `Start-Sleep -Seconds 600`, `timeout /t 600` | Waited out, up to 6 h, even with no CPU or output | overnight: background PowerShell Start-Sleep; detector: timed sleep |
| Status `shell` with a shell the app does not recognise | Judged by the activity of everything under the session | overnight: background download |
| Permission prompt, question, plan, MCP input (status `waiting`) | Waiting; finished 5 min after the prompt opened | overnight: status "waiting"; session tests |
| Older Claude Code without `waiting`: a tool call that never starts | Same, guessed from the transcript and processes | overnight: unanswered permission prompt / question |
| A slow tool (hook, big search) while status says `busy` | Working, not a prompt | session: version that reports prompts |
| Subagent, in front or in the background | Working. From 2.1.325, Claude Code itself stays `busy` while agents run, so a subagent transcript left mid-turn after the session goes idle (cut off by a usage limit, say) is a leftover | overnight: background agent; limit tests |
| Session forked from another (it writes its subagents under the original session's folder) | Before a quiet `busy` session is called stuck, writes anywhere in its project folder count | limit tests: forked session |
| Workflow (multi-agent run) | Working while its agents write | overnight: long workflow |
| `/loop` with ScheduleWakeup | Scheduled until the wake-up time + 5 min | overnight: /loop scheduled wake-ups |
| `/loop` with a fixed interval, or a reminder (CronCreate) | Scheduled until the next run + grace (see below) | overnight: hourly /loop; cron and transcript tests |
| A process started after the turn ended (e.g. an async hook) | Watched like a command: finished after 20 quiet minutes | detector: async hook |
| Session moved into a worktree | Follows the transcript copy Claude writes now | overnight and detector: worktree tests |
| `/clear`, resume, fork | The status file gets the new session id, which the app follows | — (verified in Claude Code) |
| Session closed normally | Its file is removed: nothing to wait for | — |
| Claude process crashed or was killed | Leftover file ignored (process gone or PID reused) | overnight: process dies mid-turn; detector |
| Usage limit reached, or another API error ends the turn | Shown as **Stopped** with the error text, and finished at once: helpers using CPU or subagents cut off mid-turn no longer delay it. A running command or a scheduled `/loop` still counts. Terminal: a "Session paused" dialog (`waiting`), so finished after 5 min | overnight: usage limit; limit tests |
| API errors and retries | Status stays `busy` during retries (at most a few minutes): working | — |
| PC slept and woke up | Time asleep is not counted as silence; confirmation restarts | detector: asleep; controller: wake-up tests |
| Clock jump or missed ticks during the countdown | Confirmation restarts | controller: tick gap |
| Someone uses the PC during the countdown | Watching stops (setting) | overnight: someone using the computer |
| Claude starts again during the countdown or final check | Countdown cancelled | overnight: Claude starting again; controller: final check |

**CronCreate jobs (fixed-interval `/loop`, reminders):**

- Claude Code keeps them in memory only, so the app reads them from the transcript and remembers them.
- A recurring run can start up to 30 minutes late, so the PC stays on until the next run plus 35 minutes.
- A one-shot reminder keeps the PC on until its run plus 5 minutes.
- A run more than 6 hours ahead does not keep the PC on.
- Recurring jobs end after 7 days, or when Claude calls CronDelete.

## When Claude Code changes

After an update, a changed format must not lead to a shutdown while Claude works. Each sign below keeps the PC on and shows a red warning in the window and the log:

| Sign | Result |
|---|---|
| A status value the app does not know | Session counts as working |
| No status file, but a transcript still mid-turn and recent | Result is "unknown" until the max-silence time has passed |
| A status file that cannot be read for a running process | Result is "unknown" |
| A process that cannot be matched to its session | Session counts as working |
| The process list cannot be read | Result is "unknown" |

If a warning says "Claude Code may have been updated", run `npm run detect -- --full` to see what the detector reads.

## Known limits

The app cannot see these:

- **Detached processes.** Commands started with `nohup … &`, `Start-Process` or `start` leave the session's process tree, and a shutdown kills them.
- **Work outside Windows processes.** This covers WSL (vmmem), Docker containers, remote machines and cloud jobs. Only a command that waits for them (and is still running) shows up.
- **Very quiet background work with no timed wait**, for example a poll every few minutes with tiny output. It counts as stuck after 20 minutes. Raise "Max stuck background" if you run such jobs.
- **One MCP tool call or model response with nothing written for over 45 minutes.** It counts as stuck. Raise "Max silence" if that happens.
- **Cron expressions with names** (`MON`, `JAN`). They are not read, so they do not keep the PC on.
- **Claude desktop scheduled tasks**, which are separate from session `/loop` jobs.
- **Claude in WSL or with another `CLAUDE_CONFIG_DIR`.** Settings can point at one Claude folder at a time.
- **Closing the lid or pressing the power button.** The PC still goes to sleep.
