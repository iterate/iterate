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

## Useful Commands

```bash
export S6DIR=$ITERATE_REPO/s6-daemons

s6-svstat $S6DIR/iterate-server
s6-svc -t $S6DIR/iterate-server
s6-svc -d $S6DIR/iterate-server
s6-svc -u $S6DIR/iterate-server
s6-svwait -U -t 5000 $S6DIR/iterate-server
```

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
cd "$ITERATE_REPO/apps/daemon2"
"$ITERATE_REPO/scripts/s6-healthcheck-notify.sh" http://localhost:3000/api/health &
exec env HOSTNAME=0.0.0.0 PORT=3000 tsx server.ts
```
