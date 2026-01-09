---
state: next
priority: high
size: medium
tags:
  - harness
---

# OpenCode Harness

Add OpenCode as a coding agent harness.

HTTP/SSE server architecture. One server per sandbox, multiple sessions multiplexed.

```bash
opencode serve --port 4096
```

| Endpoint                    | Purpose                   |
| --------------------------- | ------------------------- |
| `/session`                  | List/create sessions      |
| `/session/:id/prompt`       | Send message (sync)       |
| `/session/:id/prompt_async` | Send message (SSE stream) |
| `/session/:id/abort`        | Cancel operation          |
| `/event`                    | SSE event stream          |

Action handlers:

- `action:session-create:called` → `POST /session`
- `action:prompt:called` → `POST /session/:id/prompt_async`
- `action:abort:called` → `POST /session/:id/abort`

Event wrapping: Subscribe to `/event` SSE, wrap each native event as `iterate:agent:harness:opencode:event-received`.

TUI attach: `opencode attach --hostname localhost --port 4096`
