# CLI

Command-line interface for managing daemon processes.

## Installation

The CLI is available via the workspace:

```bash
# From the repo root
pnpm --filter @iterate-com/cli dev
```

## Commands

### Server Management

```bash
# Start daemon (runs in background, persists after terminal closes)
iterate server start [--port 3000]

# Check daemon status
iterate server status

# Stop daemon
iterate server stop
```

## Files

The CLI stores state in `.iterate/`:

```
.iterate/
├── daemon.pid    # PID of running daemon
├── daemon.port   # Port the daemon is listening on
└── daemon.log    # Daemon stdout/stderr logs
```

## Examples

```bash
# Start daemon on default port
iterate server start

# Start daemon on custom port
iterate server start --port 4000

# Check if daemon is running
iterate server status

# Stop the daemon
iterate server stop
```

## Related

- [`apps/daemon2`](../daemon2) - The daemon server this CLI manages
