# s6 Process Supervision

This document explains how to manage supervised services in the iterate sandbox.

## Overview

The sandbox uses [s6](https://skarnet.org/software/s6/) as a process supervisor. Services are defined in `s6-daemons/` and automatically started by `s6-svscan` when the container starts.

## Service Structure

### Minimal Service (pingpong example)

A minimal s6 service needs only one file:

```
s6-daemons/pingpong/
└── run                  # Executable script that starts the service
```

### Full Service (iterate-server example)

A full-featured service can include:

```
s6-daemons/iterate-server/
├── run                  # Executable script that starts the service
├── finish               # Optional cleanup script (runs after run exits)
├── notification-fd      # Contains "3" - enables readiness tracking
├── timeout-kill         # Contains "3000" - ms before SIGKILL after SIGTERM
├── metadata.json        # UI metadata (displayName, port, healthEndpoint, etc.)
└── log/
    └── run              # s6-log script for log rotation
```

## Current Services

| Service        | Port | Description                                                    |
| -------------- | ---- | -------------------------------------------------------------- |
| iterate-server | 3000 | Main daemon with web UI (full setup with logs/readiness)       |
| pingpong       | 3001 | Test daemon with 2s startup delay                              |
| pinger         | 3002 | Test daemon that proxies to pingpong (demonstrates dependency) |

## Environment Variables

Run scripts have access to `$ITERATE_REPO` which points to the iterate repository root. Use this instead of hardcoding paths:

```bash
#!/bin/sh
exec 2>&1
cd "$ITERATE_REPO/scripts"
exec node --experimental-strip-types test-daemon.ts --name myservice --port 3003
```

## Common Operations

Set the services directory for convenience:

```bash
export S6DIR=$ITERATE_REPO/s6-daemons
```

### Check Service Status

```bash
s6-svstat $S6DIR/iterate-server
# Output: up (pid 1234) 123 seconds, ready 120 seconds
```

### Restart a Service (Graceful)

Sends SIGTERM, waits for exit, then restarts:

```bash
s6-svc -t $S6DIR/iterate-server
```

Wait for the service to be ready after restart:

```bash
s6-svc -wU -T 5000 -t $S6DIR/iterate-server
# -wU = wait for ready
# -T 5000 = 5 second timeout
```

### Stop a Service

Stop without automatic restart:

```bash
s6-svc -d $S6DIR/iterate-server
```

Wait for the service to be completely down:

```bash
s6-svc -wD -d $S6DIR/iterate-server
```

### Start a Stopped Service

```bash
s6-svc -u $S6DIR/iterate-server
```

### Hard Restart (SIGKILL)

Use only if graceful restart doesn't work:

```bash
s6-svc -k $S6DIR/iterate-server
```

### Wait for Service Readiness

```bash
s6-svwait -U -t 5000 $S6DIR/iterate-server
# Exit code 0 = ready
# Exit code 99 = timeout
```

## Viewing Logs

### Tail Service Logs

Logs are written to `/var/log/{service-name}/current` with ISO 8601 timestamps:

```bash
# iterate-server logs
tail -f /var/log/iterate-server/current

# pingpong logs
tail -f /var/log/pingpong/current
```

### View All Container Output

Via Docker (captures s6-svscan stdout):

```bash
docker logs -f <container-id>
```

### Log Rotation

Logs are automatically rotated by s6-log:

- **Max files**: 20 archived log files
- **Max file size**: 1MB per file
- **Max total size**: 50MB (oldest deleted when exceeded)
- **Timestamps**: ISO 8601 format (human-readable)

Log files:

```
/var/log/{service}/
├── current             # Active log file
└── @timestamp.s        # Rotated archives
```

## Health Checks

Each service has a health endpoint defined in `metadata.json`:

```bash
# iterate-server
curl http://localhost:3000/api/health

# pingpong
curl http://localhost:3001/health
```

## How Services Integrate with s6

### Readiness Notification via Health Check

Services don't need to implement s6-specific code. A helper script polls the health endpoint and notifies s6 when ready.

The `run` script pattern:

```bash
#!/bin/sh
exec 2>&1
cd "$HOME/src/github.com/iterate/iterate/apps/daemon2"

# Health checker in background - polls endpoint, notifies s6, then exits
"$HOME/src/github.com/iterate/iterate/scripts/s6-healthcheck-notify.sh" \
  http://localhost:3000/api/health &

# Run the service (receives signals directly)
exec env PORT=3000 node dist/server/index.mjs
```

The health checker runs in the background, polls until healthy, writes to fd 3, then exits. The service is exec'd directly, so it receives signals without any wrapper overhead.

**Note**: For readiness tracking to work, the service needs a `notification-fd` file containing "3". Without it, s6 won't wait for the notification (the service will show "up" but not "ready").

### Graceful Shutdown

Services handle SIGTERM to drain connections:

1. Stop accepting new connections
2. Wait for in-progress requests to complete
3. Exit with code 0

If the service doesn't exit within 3000ms (timeout-kill), s6 sends SIGKILL.

### The `finish` Script

Runs after the service exits. Used to:

- Kill orphaned child processes
- Clean up temporary files
- Log exit status

## Troubleshooting

### Service Won't Start

Check the run script is executable:

```bash
ls -la $S6DIR/iterate-server/run
```

Check the run script syntax:

```bash
sh -n $S6DIR/iterate-server/run
```

### Service Keeps Restarting

Check logs for crash reasons:

```bash
tail -100 /var/log/iterate-server/current
```

Check the supervise directory for status:

```bash
ls -la $S6DIR/iterate-server/supervise/
```

### Logs Not Being Written

Ensure log directory is writable:

```bash
ls -la /var/log/iterate-server/
```

Check s6-log is running:

```bash
s6-svstat $S6DIR/iterate-server/log
```
