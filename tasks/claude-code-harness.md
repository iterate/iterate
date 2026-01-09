---
state: next
priority: high
size: medium
tags:
  - harness
---

# Claude Code Harness

Add Claude Code as a coding agent harness.

CLI-per-invocation via SDK. SDK spawns CLI binary internally.

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const response = query({
  prompt: "Hello",
  options: {
    model: "claude-sonnet-4-5",
    cwd: process.cwd(),
    resume: sessionId,
    allowedTools: ["Read", "Write", "Edit", "Bash"],
    permissionMode: "acceptEdits",
    abortController,
  },
});

for await (const message of response) {
  // Wrap as iterate:agent:harness:claude:event-received
}
```

~12 seconds startup overhead per query (SDK spawns fresh CLI process).

Global hooks for CLI sessions (user SSH): Configure in `~/.claude/settings.json` to forward lifecycle events.

Concurrency warning: No file locking on sessions. Concurrent SDK + CLI access causes corruption.

TUI resume: `claude --resume <session-id>`
