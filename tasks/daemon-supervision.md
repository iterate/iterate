---
state: next
priority: high
size: medium
tags:
  - sandbox
  - infrastructure
---

# Daemon Supervision

The entry point for daemons running in sandboxes should be a supervisor/bootstrapper, so the daemon runs under supervision (e.g., s6).

# Claude research

# s6-overlay as a process supervisor in Daytona sandboxes

**s6-overlay v3 provides the most robust pattern for dynamically managing customer-defined daemon processes in Daytona sandboxes.** The key insight: while s6-rc is fundamentally static (services must be compiled into a database), the `s6-rc-update` command enables atomic live updates—making it ideal for an orchestrator that watches git config files and reconciles service state. The main challenge lies in Daytona's own daemon entrypoint system, which requires careful integration to avoid blocking internal sandbox communication.

## s6-rc architecture enables dependency-aware service management

The s6-overlay v3 pattern uses **s6-rc** (service manager) atop **s6-svscan** (process supervisor). This two-layer architecture separates concerns: s6-svscan handles zombie reaping, signal forwarding, and process respawning, while s6-rc manages service state, dependencies, and ordered startup/shutdown.

Service definitions live in `/etc/s6-overlay/s6-rc.d/` with this structure for a longrun daemon:

```
/etc/s6-overlay/s6-rc.d/myservice/
├── type                    # Contains: "longrun"
├── run                     # Executable: starts daemon in foreground
├── finish                  # Optional: cleanup on exit
├── dependencies.d/
│   ├── base                # Empty file - always include this
│   └── other-service       # Empty file - depends on other-service
├── notification-fd         # Contains: "3" (fd for readiness signal)
└── timeout-up              # Optional: max ms to wait for start
```

Services register for automatic startup by adding an empty file to the user bundle: `touch /etc/s6-overlay/s6-rc.d/user/contents.d/myservice`. The **dependencies.d/** directory uses empty files named after dependencies—s6-rc-compile builds the dependency graph automatically, starting services in parallel where possible while respecting order constraints.

For oneshot services (initialization tasks), the structure differs slightly:

```
/etc/s6-overlay/s6-rc.d/init-task/
├── type                    # Contains: "oneshot"
├── up                      # Single command line (NOT a script)
└── dependencies.d/base
```

The `up` file contains a single execlineb command line, not a shell script. To run complex logic: `/etc/s6-overlay/scripts/init-task.sh` pointing to an external executable.

## Dynamic service management requires the compile-update workflow

**You cannot drop new service directories into s6-rc and have them automatically recognized.** All changes require compiling a new database and atomically switching to it. This is by design—Laurent Bercot (s6 author) emphasizes reliability over flexibility: "The current version of s6-rc is very static and focuses on reliability and predictability."

The orchestrator workflow for adding a service at runtime:

```bash
#!/bin/bash
SERVICE_NAME="$1"
SOURCE_DIR="/etc/s6-rc/source"
COMPILED_BASE="/etc/s6-rc"
TIMESTAMP=$(date +%s)

# 1. Copy service definition to source directory
cp -r "/path/to/new/service" "$SOURCE_DIR/$SERVICE_NAME"
touch "$SOURCE_DIR/$SERVICE_NAME/dependencies.d/base"
touch "$SOURCE_DIR/user/contents.d/$SERVICE_NAME"

# 2. Compile new database
s6-rc-compile "$COMPILED_BASE/compiled-$TIMESTAMP" "$SOURCE_DIR"

# 3. Atomically switch live state
s6-rc-update -l /run/s6-rc "$COMPILED_BASE/compiled-$TIMESTAMP"

# 4. Update boot symlink (for persistence)
s6-ln -nsf "compiled-$TIMESTAMP" "$COMPILED_BASE/compiled"
```

**s6-rc-update** analyzes current vs new databases and computes minimal transitions. Services restart only when: they're removed, their type changed (oneshot↔longrun), a dependency must restart, or explicitly forced via conversion file. For service removal, simply delete from source and recompile—s6-rc-update automatically stops orphaned services.

Individual service control without recompilation uses `s6-rc change`:

| Action                            | Command                              |
| --------------------------------- | ------------------------------------ |
| Start service                     | `s6-rc -u change servicename`        |
| Stop service                      | `s6-rc -d change servicename`        |
| Stop all services                 | `s6-rc -da change`                   |
| Bring up exact set (prune others) | `s6-rc -pu change bundlename`        |
| Restart longrun                   | `s6-svc -r /run/service/servicename` |

## Container integration requires careful entrypoint design

The s6-overlay `/init` entrypoint executes a **three-stage process**: Stage 1 handles container setup (saving environment to `/run/s6/container_environment/`, mounting `/run`), Stage 2 starts services in dependency order, and Stage 3 performs graceful shutdown.

**Critical Dockerfile pattern for s6-overlay v3:**

```dockerfile
FROM ubuntu:22.04
ARG S6_OVERLAY_VERSION=3.2.1.0

# Install s6-overlay
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz /tmp
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-x86_64.tar.xz /tmp
RUN tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz && \
    tar -C / -Jxpf /tmp/s6-overlay-x86_64.tar.xz

# Service definitions
COPY rootfs/etc/s6-overlay /etc/s6-overlay
RUN chmod +x /etc/s6-overlay/s6-rc.d/*/run

ENTRYPOINT ["/init"]
```

Environment variables from container startup are saved to individual files in `/run/s6/container_environment/`. Services access these via the `with-contenv` helper:

```bash
#!/command/with-contenv bash
exec 2>&1  # Redirect stderr to stdout for logging
exec s6-setuidgid myuser myapp --config "$CONFIG_PATH"
```

**Key environment variables for tuning behavior:**

| Variable                       | Default | Purpose                               |
| ------------------------------ | ------- | ------------------------------------- |
| `S6_VERBOSITY`                 | 2       | Log level (0-5)                       |
| `S6_KILL_GRACETIME`            | 3000    | ms before SIGKILL after SIGTERM       |
| `S6_CMD_WAIT_FOR_SERVICES`     | 0       | Wait for service readiness before CMD |
| `S6_BEHAVIOUR_IF_STAGE2_FAILS` | 0       | 0=continue, 1=warn, 2=stop container  |

## Daytona integration presents specific challenges

Daytona v0.123.0 introduced a **dedicated daemon sandbox entrypoint** that unifies entry logic within its daemon and runner components. This creates potential conflicts with s6-overlay's `/init`.

**Key Daytona behaviors affecting s6-overlay integration:**

- **Filesystem persistence**: Stopped sandboxes maintain filesystem state but clear memory state—all running processes terminate. s6 service definitions persist, but services must be restarted on sandbox start.
- **Default entrypoint**: If an image has no long-running entrypoint, Daytona runs `sleep infinity` to prevent immediate exit.
- **Custom entrypoints**: Set via Snapshot configuration (dashboard or SDK) with `.entrypoint(["/init"])`.

**Integration challenges to address:**

| Challenge                    | Mitigation                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| Daytona daemon communication | Ensure s6-overlay doesn't block internal agent/toolbox processes                          |
| Process visibility           | Daytona's Sessions API won't see s6-supervised processes directly                         |
| Log access                   | Bridge s6 logs to paths Daytona's log streaming can access                                |
| Stop/Start cycles            | Services don't auto-restart—configure s6-overlay to start `user` bundle on container init |

**Recommended architecture**: Rather than replacing Daytona's entrypoint entirely, create a wrapper that launches both Daytona's internal processes and s6-overlay:

```bash
#!/bin/bash
# /custom-init.sh - Wrapper entrypoint
# Start s6-overlay supervision tree
exec /init "$@"
```

## Logging architecture uses dedicated logger services

s6 follows a logging chain philosophy: each longrun service can have a paired logger service that reads its stdout via a pipe maintained by s6-svscan.

**Modern s6-rc logging pattern with producer/consumer:**

```
/etc/s6-overlay/s6-rc.d/myapp/
├── type                # "longrun"
├── run
├── producer-for        # Contains: "myapp-log"
└── dependencies.d/base

/etc/s6-overlay/s6-rc.d/myapp-log/
├── type                # "longrun"
├── run
├── consumer-for        # Contains: "myapp"
├── pipeline-name       # Contains: "myapp-pipeline"
└── notification-fd     # Contains: "1"
```

The logger's run script uses s6-log with rotation configuration:

```bash
#!/bin/sh
exec s6-log -d1 n20 s1000000 T /var/log/myapp
```

**s6-log rotation directives:**

| Directive   | Description                             |
| ----------- | --------------------------------------- |
| `n20`       | Keep 20 archived log files              |
| `s1000000`  | Rotate at ~1MB                          |
| `T`         | ISO 8601 timestamps (human-readable)    |
| `t`         | TAI64N timestamps (requires conversion) |
| `S15000000` | Max 15MB total for all archives         |

Log files appear as `/var/log/myapp/current` (active) and `@timestamp.s` (rotated archives). To make logs accessible via Daytona's Sessions API, either symlink log directories to paths Daytona monitors, or create a log-forwarding service that tails s6 logs and writes to stdout captured by Daytona.

## Health checks use native readiness notification

s6 supports daemon-initiated readiness notification through the `notification-fd` mechanism. The daemon writes a newline to the specified file descriptor when ready to serve:

```bash
#!/command/with-contenv sh
exec 2>&1
exec myapp --foreground --notify-fd=3  # Writes \n to fd 3 when ready
```

With `notification-fd` containing `3`, s6-rc waits for this signal before considering the service "up and ready." Dependent services won't start until readiness is confirmed.

For daemons without native notification support, use **s6-notifyoncheck** with a polling script:

```bash
#!/bin/sh
exec s6-notifyoncheck -w 1000 -n 30 -- myapp-daemon
```

This polls `./data/check` every 1000ms up to 30 times. The check script should exit 0 when ready:

```bash
#!/bin/sh
# ./data/check
curl -sf http://localhost:8080/health || exit 1
```

**Query service status programmatically:**

```bash
s6-svstat /run/service/myapp
# Output: up (pid 1234) 123 seconds, ready 120 seconds

s6-svwait -U -t 5000 /run/service/myapp  # Wait up to 5s for ready
```

## Orchestrator pattern for git-based config watching

Your orchestrator service should be an s6 longrun that watches the git repo and reconciles service state. Here's the architectural pattern:

```
/etc/s6-overlay/s6-rc.d/service-orchestrator/
├── type                # "longrun"
├── run
├── notification-fd     # "3"
└── dependencies.d/base
```

**Orchestrator run script logic:**

```bash
#!/command/with-contenv bash
exec 2>&1
SOURCE_DIR="/etc/s6-rc/source"
COMPILED_BASE="/etc/s6-rc"
CONFIG_REPO="/workspace/config"

# Signal readiness after initial reconciliation
reconcile_services() {
    TIMESTAMP=$(date +%s)
    # Generate service definitions from config files
    for config in "$CONFIG_REPO"/services/*.yaml; do
        service_name=$(basename "$config" .yaml)
        generate_service_definition "$config" "$SOURCE_DIR/$service_name"
    done

    # Prune services not in config
    for existing in "$SOURCE_DIR"/*/; do
        service_name=$(basename "$existing")
        [[ "$service_name" =~ ^(base|user|user2)$ ]] && continue
        if [[ ! -f "$CONFIG_REPO/services/${service_name}.yaml" ]]; then
            rm -rf "$existing"
            rm -f "$SOURCE_DIR/user/contents.d/$service_name"
        fi
    done

    # Compile and update
    if s6-rc-compile "$COMPILED_BASE/compiled-$TIMESTAMP" "$SOURCE_DIR"; then
        s6-rc-update -l /run/s6-rc "$COMPILED_BASE/compiled-$TIMESTAMP"
        s6-ln -nsf "compiled-$TIMESTAMP" "$COMPILED_BASE/compiled"
    fi
}

# Initial reconciliation
reconcile_services
echo "" >&3  # Signal readiness

# Watch for config changes (using inotifywait or git poll)
while true; do
    inotifywait -r -e modify,create,delete "$CONFIG_REPO/services" 2>/dev/null
    reconcile_services
done
```

**Key patterns for graceful handling:**

- **Diff detection**: Before recompiling, compare current vs desired state to minimize unnecessary restarts
- **Conversion files**: Use s6-rc-update's `-f convfile` to force restarts of specific services when config changes
- **Atomic updates**: The s6-ln/mv pattern ensures boot persistence survives partial failures
- **Timeout handling**: Set explicit `timeout-up` in service definitions to fail fast on broken configs

## Practical implementation checklist

For deploying this pattern in Daytona:

1. **Create base image** with s6-overlay v3 installed and orchestrator service defined
2. **Configure Daytona Snapshot** with `/init` entrypoint
3. **Mount config repo** as Daytona volume for persistence across sandbox stop/start
4. **Store compiled databases** in persistent path (not `/run` which is tmpfs)
5. **Bridge logging** to paths accessible via Daytona's Sessions API
6. **Handle sandbox lifecycle**: On start, orchestrator runs reconciliation automatically via s6-rc's `user` bundle
7. **Test stop/start cycles**: Verify services restore correctly from persisted state

The s6-rc compile-update workflow adds **~100-500ms overhead** per reconciliation depending on service count—acceptable for config-driven changes but not suitable for high-frequency dynamic scaling. For that use case, consider combining s6-overlay for stable services with Daytona's Sessions API for ephemeral processes.
