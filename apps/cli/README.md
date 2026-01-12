# CLI

Command-line interface for managing daemon processes and interacting with agent streams.

## Auto-Daemon Architecture

The CLI implements "auto-daemon" behavior: when you run agent commands, it automatically starts the daemon if not already running.

```
┌────────────────────────────────────────────────────────────────────────────┐
│                              CLI Command Flow                               │
└────────────────────────────────────────────────────────────────────────────┘

  User runs: iterate prompt my-agent "Hello"
                          │
                          ▼
              ┌───────────────────────┐
              │  Check EVENT_STREAM_URL │
              │  environment variable   │
              └───────────────────────┘
                          │
              ┌───────────┴───────────┐
              │                       │
         Set (explicit URL)    Not set (auto-daemon)
              │                       │
              ▼                       ▼
     Use provided URL      ┌──────────────────────┐
                           │ Check .iterate/daemon.pid │
                           └──────────────────────┘
                                      │
                           ┌──────────┴──────────┐
                           │                     │
                     PID exists             No PID file
                     & running              or not running
                           │                     │
                           ▼                     ▼
                   Read port from         ┌───────────────┐
                   .iterate/daemon.port   │ Auto-start    │
                           │              │ daemon server │
                           │              └───────────────┘
                           │                     │
                           └──────────┬──────────┘
                                      │
                                      ▼
                           ┌──────────────────────┐
                           │  Execute command via  │
                           │  HTTP to daemon       │
                           └──────────────────────┘
```

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

### Agent Operations

```bash
# Send a prompt to an agent
iterate prompt <stream-name> "Your message here"

# Abort current operation
iterate abort <stream-name>

# Subscribe to stream events (real-time)
iterate subscribe <stream-name>

# List all streams
iterate list
```

## Configuration

| Environment Variable | Description                             | Default     |
| -------------------- | --------------------------------------- | ----------- |
| `EVENT_STREAM_URL`   | Override server URL (skips auto-daemon) | Auto-detect |
| `PORT`               | Daemon port (via server start)          | `3000`      |

## Files

The CLI and daemon store state in `.iterate/`:

```
.iterate/
├── daemon.pid    # PID of running daemon
├── daemon.port   # Port the daemon is listening on
├── daemon.log    # Daemon stdout/stderr logs
└── streams/      # Persisted event streams (JSON)
```

## Examples

```bash
# Start daemon explicitly
iterate server start --port 4000

# Or just run a command (auto-starts daemon)
iterate prompt my-agent "Write a hello world in Python"

# Watch events in real-time
iterate subscribe my-agent

# In another terminal, send more prompts
iterate prompt my-agent "Now make it print the date"
```

## Related

- [`apps/daemon2`](../daemon2) - The daemon server this CLI manages
