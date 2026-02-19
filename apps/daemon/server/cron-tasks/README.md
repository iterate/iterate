# Cron Tasks

Markdown-file-based task queue for scheduled agent work.

## Design

**One dumb cron, smart tasks**: A single scheduler runs every N minutes (env var `CRON_TASK_INTERVAL_MS`, default 1 min). It scans a folder for pending tasks, processes any that are due.

**Tasks are markdown files** with YAML frontmatter. Human-readable, git-trackable, easy to debug.

## Task Lifecycle

```
pending -> in_progress -> completed (archived/ for one-off, stays in tasks/ for recurring)
                       -> abandoned (moved to archived/)
                       -> pending (on failure or reopen)
```

## Frontmatter Schema

```yaml
---
state: pending # pending | in_progress | completed | abandoned
due: 2026-01-28T09:00Z # ISO timestamp - task runs after this time
schedule: "0 9 * * *" # optional cron expression for recurring tasks
lockedBy: cron-abc123 # agent slug when in_progress
lockedAt: 2026-01-28T09:01Z # when the agent started working
priority: normal # low | normal | high (processing order)
---
```

## File Structure

```
iterate/tasks/
  daily-report.md       # active task (pending or in_progress)
  send-reminder.md
  archived/
    2026-01-28-one-off-task.md  # completed/abandoned tasks
```

Tasks live directly in `tasks/`. Only one-off completed tasks and abandoned tasks move to `archived/`.

## Agent Model

Each task execution creates a **cron agent**. The cron agent:

1. Reads the task markdown as its initial prompt
2. Does the work (may send messages, write code, etc.)
3. Marks the task complete with a note

## Recurring Tasks

Tasks with `schedule` in frontmatter stay in the main folder:

1. Agent completes the task with `iterate task complete --slug "..." --note "..."`
2. Task resets to `pending` with next due date calculated from schedule
3. Task stays in `tasks/` (not archived)

To stop a recurring task, remove the `schedule` field before completing, or abandon it.

## Failure Handling

**On agent/system failure** (exception during task processing):

- Failure note appended to task body
- State reset to `pending`
- Task retries on next scheduler run

**If the agent can't complete the task right now** but might later:

- Use `iterate task reopen --slug "..." --note "..."` to reset to pending
- This works for both `in_progress` and archived tasks

**If the task should not be retried**:

- Use `iterate task abandon --slug "..." --note "..."` to move to archived

## Watchdog

A stale task watchdog runs alongside the scheduler (env var `STALE_TASK_INTERVAL_MS`, `STALE_TASK_THRESHOLD_MS`).

It checks for `in_progress` tasks locked longer than the threshold and sends a nudge message to the agent:

- "Are you done? Run `iterate task complete`"
- "Still working? Reply with status"
- "Stuck? Run `iterate task abandon`"

The nudge updates `lockedAt` to avoid spamming. If the task was already completed (file deleted), the watchdog skips gracefully.

## CLI Commands

```bash
# List all commands
iterate task --help

# List active tasks
iterate task list

# Get a specific task
iterate task get --slug daily-report

# Add a new task (due in 24 hours)
iterate task add \
  --slug daily-report \
  --due "24h" \
  --schedule "0 9 * * *" \
  --priority normal \
  --body "# Daily Report\n\nSend summary to Slack."

# Mark complete (required note)
iterate task complete --slug daily-report --note "Done. Posted to #general"

# Abandon (required note)
iterate task abandon --slug daily-report --note "User asked to stop"

# Reopen from archive or reset in_progress to pending
iterate task reopen --slug daily-report --note "User wants another attempt"

# Manually trigger processing
iterate task processPending
```

## Implementation

- Scheduler: `scheduler.ts`
- Pure parsing functions: `task-parser.ts`
- CLI router: `apps/daemon/server/trpc/procedures/tasks.ts`

If something is broken, the agent can read these files to understand and fix the issue.
