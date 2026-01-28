# Cron Tasks

Markdown-file-based task queue for scheduled agent work.

## Design

**One dumb cron, smart tasks**: A single scheduler runs every N minutes (env var `CRON_TASK_INTERVAL_MS`, default 15 min in prod). It scans a folder for pending tasks, processes any that are due.

**Tasks are markdown files** with YAML frontmatter. Human-readable, git-trackable, easy to debug.

## Task Lifecycle

```
pending -> in_progress -> completed (moved to completed/)
                       -> pending (on failure, with note appended)
```

## Frontmatter Schema

```yaml
---
state: pending # pending | in_progress | completed
due: 2026-01-28T09:00Z # ISO timestamp - task runs after this time
schedule: "0 9 * * *" # optional cron expression for recurring tasks
lockedBy: cron-abc123 # agent slug when in_progress (derived createdAt = lockedAt)
priority: normal # low | normal | high (processing order)
---
```

Note: `workingDirectory` and `harnessType` are derived from environment (customer repo path, opencode harness).

## File Structure

```
apps/daemon/
  cron-tasks/
    pending/
      daily-report.md
      send-reminder.md
    completed/
      2026-01-28-daily-report.md
```

Using folders for state (not frontmatter) because:

- Cleaner working directory
- Easy to see what's pending at a glance
- Git history preserved in completed/

## Agent Model

Each task execution creates a **cron agent** (not a slack/email agent). The cron agent:

1. Reads the task markdown as its initial prompt
2. Does the work (may send messages to other channels)
3. Reports completion

If the task triggers a user reply (e.g., sends a Slack message), that becomes a _separate_ agent naturally via webhooks.

## Recurring Tasks

Tasks with `schedule` in frontmatter self-replicate:

1. Cron agent completes the task
2. Before archiving, check if `schedule` exists
3. Calculate next due date from cron expression
4. Create new pending task with updated `due`
5. Move original to completed/

The task prompt should include instructions about modifying/nulling the schedule if needed.

## Failure Handling

On failure:

1. Append failure note to task body (timestamp, error summary)
2. Set state back to `pending`
3. Keep original due date (retry on next cron run)
4. After N failures, could move to `failed/` folder (future enhancement)

## Watchdog (Future)

Separate cron to check on long-running tasks:

- Query agents table for `lockedBy` agent slugs
- Check activity on those agents
- Send nudge message: "Task X has been in_progress for 2 hours. Are you stuck?"

## Example Task

```markdown
---
state: pending
due: 2026-01-28T09:00:00Z
schedule: "0 9 * * *"
priority: normal
---

# Daily US Box Office Report

Send a summary of yesterday's US box office numbers to #movie-club on Slack.

Include:

- Top 5 films by gross
- Notable changes from previous week
- Any new releases

After completing, this task will auto-recreate for tomorrow at 9am.
If this report is no longer needed, update the schedule to null before completing.
```

## CLI Commands

Manage tasks via the CLI:

```bash
# List pending tasks
iterate task list

# List completed tasks
iterate task list --state completed

# Get a specific task
iterate task get --filename daily-report.md

# Add a new task
iterate task add \
  --filename daily-report.md \
  --due 2026-01-29T09:00:00Z \
  --schedule "0 9 * * *" \
  --priority normal \
  --body "# Daily Report\n\nSend summary to Slack."
```

## Implementation

See `scheduler.ts` for the cron implementation.

## TODOs / Open Questions

1. **Agent completion detection**: Currently agents run async via OpenCode SDK. Need a callback mechanism when agent completes to:
   - Call `markTaskCompleted()`
   - Handle recurring task recreation
   - Move to completed/ folder

   Options:
   - Poll agent status periodically
   - Add completion webhook/callback to agent harness
   - Have the agent itself call a completion endpoint

2. **Cron expression parsing**: Currently `createNextRecurrence` just adds 24 hours. Need proper cron parsing (e.g., `cron-parser` npm package).

3. **Max retries**: Add `maxRetries` frontmatter field and move to `failed/` folder after N failures.

4. **Watchdog**: Implement the separate cron to check on long-running tasks using `lockedBy` agent slug.
