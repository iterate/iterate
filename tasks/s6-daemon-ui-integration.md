---
state: next
priority: medium
size: large
tags:
  - sandbox
  - ui
  - daemon
dependsOn:
  - tasks/daemon-supervision.md
---

# s6 Daemon UI Integration

Expose s6-supervised daemons in the apps/os UI with full control and visibility.

## Background

The sandbox now uses s6 for process supervision. Each service in `s6-daemons/` has a `metadata.json` file with UI-relevant information:

```typescript
interface S6DaemonMetadata {
  displayName: string;
  description?: string;
  port?: number;
  healthEndpoint?: string;
  hasWebUI?: boolean;
}
```

## Requirements

### 1. tRPC Procedures

Add new tRPC procedures in daemon to interact with s6:

#### `s6.listDaemons`

- Read all directories in `s6-daemons/`
- Parse `metadata.json` from each
- Return list with display names, ports, etc.

#### `s6.getDaemonStatus`

- Run `s6-svstat` for a specific daemon
- Parse output: `up (pid X) Y seconds, ready Z seconds` or `down (signal X) Y seconds`
- Return structured status object

#### `s6.tailLogs`

- Stream from `/var/log/{service}/current`
- Use subscription or SSE for live updates
- Support optional line count limit

#### `s6.restartDaemon`

- Run `s6-svc -t {service}`
- Optionally wait for ready with `s6-svc -wU -T 5000 -t`

#### `s6.stopDaemon`

- Run `s6-svc -d {service}`

#### `s6.startDaemon`

- Run `s6-svc -u {service}`

#### `s6.checkHealth`

- Call the health endpoint from `metadata.json`
- Return health status

### 2. UI Components

#### Daemon List View

- Show all daemons with:
  - Display name (from metadata)
  - Status indicator (up/down/ready with colors)
  - Port number
  - Health status
  - Restart/Stop/Start buttons

#### Log Viewer

- Live-updating log viewer per daemon
- Auto-scroll with stick-to-bottom
- Optional filtering/search
- Line wrapping toggle

#### Daemon Detail Panel

- Expanded view when clicking a daemon
- Full metadata display
- Control buttons
- Link to web UI if `hasWebUI: true`

### 3. Port Proxy Integration

When a daemon exposes a port (from `metadata.json`), show a clickable link to access it via Daytona's proxy:

```
https://{port}-{sandbox_id}.proxy.daytona.works
```

The sandbox ID should be available from environment or context.

## Implementation Notes

### Executing s6 Commands

The daemon server runs inside the same container as s6. Use Node.js `child_process` to execute s6 commands:

```typescript
import { execSync } from "node:child_process";

function getS6Status(service: string): string {
  return execSync(`s6-svstat ${S6_DAEMONS_PATH}/${service}`, {
    encoding: "utf-8",
  });
}
```

### Parsing s6-svstat Output

Example outputs:

- `up (pid 1234) 60 seconds, ready 55 seconds`
- `down (exitcode 0) 5 seconds, ready 0 seconds`
- `down (signal SIGTERM) 3 seconds`

### Log Tailing

Use Node.js `fs.watch` or `tail -f` via child process for live updates. Consider using a library like `tail` for robustness.

### Status Polling vs Subscriptions

Options:

1. **Polling**: Simple, use React Query with refetch interval
2. **Subscriptions**: Use tRPC subscriptions with WebSocket
3. **SSE**: Use server-sent events for one-way streaming

Recommendation: Start with polling (every 2-5 seconds), add subscriptions later if needed.

## Files to Modify/Create

| File                                             | Action                         |
| ------------------------------------------------ | ------------------------------ |
| `apps/daemon/src/integrations/trpc/s6-router.ts` | Create - s6 tRPC procedures    |
| `apps/daemon/src/integrations/trpc/router.ts`    | Modify - add s6 router         |
| `apps/daemon/src/routes/daemons.tsx`             | Create - daemons page          |
| `apps/daemon/src/components/daemon-list.tsx`     | Create - daemon list component |
| `apps/daemon/src/components/log-viewer.tsx`      | Create - log viewer component  |

## Verification

1. Navigate to daemons page in UI
2. See list of all daemons with statuses
3. Click restart on a daemon, see it go down then up
4. View live logs for a daemon
5. Click web UI link, opens in new tab via proxy
