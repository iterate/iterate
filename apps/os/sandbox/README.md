# Sandbox Supervision (s6)

The sandbox container uses [s6](https://skarnet.org/software/s6/) to supervise services in `s6-daemons/`. `s6-svscan` starts everything on boot.

## Service Layout

Minimal service:

```
s6-daemons/example-service-a/
└── run
```

Full service with logs:

```
s6-daemons/iterate-server/
├── run
├── finish
├── notification-fd
├── timeout-kill
├── metadata.json
└── log/
    └── run
```

## Current Services

| Service                        | Port | Logs                         | Description                    |
| ------------------------------ | ---- | ---------------------------- | ------------------------------ |
| iterate-server                 | 3000 | `/var/log/iterate-server`    | Main daemon + web UI           |
| example-service-a              | 3001 | stdout                       | Test daemon (2s startup delay) |
| example-service-b-depends-on-a | 3002 | `/var/log/example-service-b` | Test daemon proxying service-a |

## Managing Services

All commands assume you're inside the container. Set up the path shortcut first:

```bash
export S6DIR=/root/src/github.com/iterate/iterate/s6-daemons
```

### Check Service Status

```bash
# Single service status
s6-svstat $S6DIR/iterate-server
# Output: up (pid 563) 471 seconds, ready 471 seconds

# All services status
for svc in $S6DIR/*/; do echo "=== $(basename $svc) ==="; s6-svstat "$svc"; done
```

### Restart a Service

```bash
# Send SIGTERM and restart (graceful restart)
s6-svc -t $S6DIR/iterate-server

# Hard restart: stop then start
s6-svc -d $S6DIR/iterate-server  # stop (down)
s6-svc -u $S6DIR/iterate-server  # start (up)
```

### Other Service Controls

```bash
# Stop a service (stays down until manually started)
s6-svc -d $S6DIR/iterate-server

# Start a stopped service
s6-svc -u $S6DIR/iterate-server

# Send SIGKILL (force kill)
s6-svc -k $S6DIR/iterate-server

# Wait for service to be up and ready (5s timeout)
s6-svwait -U -t 5000 $S6DIR/iterate-server
```

### Quick Reference

| Command                      | Action                               |
| ---------------------------- | ------------------------------------ |
| `s6-svstat <svc>`            | Show status (pid, uptime, readiness) |
| `s6-svc -t <svc>`            | Restart (SIGTERM + auto-restart)     |
| `s6-svc -d <svc>`            | Stop (down)                          |
| `s6-svc -u <svc>`            | Start (up)                           |
| `s6-svc -k <svc>`            | Force kill (SIGKILL)                 |
| `s6-svwait -U -t <ms> <svc>` | Wait for ready state                 |

## Logs

```bash
docker logs <container-id>
docker exec <container-id> tail -f /var/log/iterate-server/current
```

## Health Checks

```bash
curl http://localhost:3000/api/health
curl http://localhost:3001/health
curl http://localhost:3002/health
```

## Run Script Pattern

Run scripts get `$ITERATE_REPO`:

```bash
#!/bin/sh
exec 2>&1
cd "$ITERATE_REPO/apps/daemon"
"$ITERATE_REPO/scripts/s6-healthcheck-notify.sh" http://localhost:3000/api/health &
exec env HOSTNAME=0.0.0.0 PORT=3000 tsx server.ts
```
