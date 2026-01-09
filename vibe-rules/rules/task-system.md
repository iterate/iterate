---
description: "Task system for tracking work"
alwaysApply: true
---

# Task System

**This is a no-stress task system.** Don't overthink any of this — it's all very malleable. With AI, we can have a conversation later to rejig everything, re-categorize, change what "large" means, etc. Just capture things and move on.

## Structure

- Any `.md` file in `tasks/` or subdirectories = a task
- The path relative to repo root is the "task ID"
- Optional YAML frontmatter:

```yaml
---
state: todo | next | in-progress | done
tags:
  - security
  - harness
  - infrastructure
dependsOn:
  - tasks/other-task.md
  - tasks/infra/setup-db.md
priority: high | medium | low
certainty: high | medium | low
size: large | medium | small
difficulty: high | medium | low
---
```

### States

| State         | Meaning                                     |
| ------------- | ------------------------------------------- |
| `todo`        | Captured, not yet prioritized for near-term |
| `next`        | Prioritized, ready to work on soon          |
| `in-progress` | Currently being worked on                   |
| `done`        | Completed                                   |

Paths in `dependsOn` are relative to repo root.

---

## Processes

### 1. Working on a Task

1. Read the task file
2. Check `dependsOn` — if dependencies exist, do those first
3. Research & clarify: Is this well-defined? Ask user if unclear
4. Execute

### 2. Recording a Task

Quick capture. Don't overthink.

1. Create file in `tasks/` with a reasonable name (make one up if needed)
2. Write brief description
3. Say: "Recorded in `tasks/xyz.md`. Here's what I wrote. Want changes? Should I check for dependencies?"

### 3. Task Pruning

Holistic review of all tasks at once:

1. Read everything in `tasks/`
2. Check relationships — are `dependsOn` links accurate?
3. Still necessary? Research if unclear
4. Missing anything? Add new tasks
5. Remove/archive completed or obsolete tasks
