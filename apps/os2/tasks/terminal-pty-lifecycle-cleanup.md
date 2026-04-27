---
state: backlog
priority: low
size: medium
dependsOn: []
---

# Terminal: simplify PTY lifecycle and route contract

Current `apps/os2` terminal behavior is messy and mixes PTY creation,
session resume, and client-side URL mutation in one flow.

Today:

- Visiting `/terminal` lets the client open `/api/pty` without a required PTY id
- The server implicitly creates a PTY during the websocket handshake
- The client then writes the returned `ptyId` back into the URL and reconnects
- This makes the lifecycle harder to reason about and produces noisy upgrade logs

Desired direction:

- Accessing `/terminal` should explicitly create a new PTY on the server
- The terminal route should then navigate to a PTY-specific path that encodes the
  PTY identity up front
- The client websocket should require that PTY id from the route path rather than
  discovering it mid-connection
- Resume behavior should be explicit and separate from "create a fresh terminal"

For now leave the current implementation as-is; this is a cleanup/follow-up task,
not an immediate behavior change.
