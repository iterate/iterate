# Daemon

A Hono-based HTTP server that provides real-time event streaming and agent management. The daemon manages Pi coding agent sessions and persists events to the filesystem.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Daemon Server                              │
│  ┌─────────────────────┐   ┌────────────────────────────────────┐   │
│  │   Hono HTTP Server  │   │      StreamManagerService          │   │
│  │                     │   │  ┌─────────────┐  ┌─────────────┐  │   │
│  │  /agents/* routes   │◄──│  │ EventStream │  │   Storage   │  │   │
│  │  /streams/* routes  │   │  │   (Effect)  │  │  (FileSystem)│  │   │
│  └─────────────────────┘   │  └─────────────┘  └─────────────┘  │   │
│           │                └────────────────────────────────────┘   │
│           │ SSE                          │                          │
│           ▼                              ▼                          │
│  ┌─────────────────────┐   ┌────────────────────────────────────┐   │
│  │    Web UI (React)   │   │         Pi Adapter                  │   │
│  │  /ui/* static files │   │  - Subscribes to stream events      │   │
│  └─────────────────────┘   │  - Manages Pi SDK sessions          │   │
│                            │  - Wraps Pi events → stream events  │   │
│                            └────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                        ┌──────────────────────┐
                        │    .iterate/streams/ │
                        │    (JSON files)      │
                        └──────────────────────┘
```

## Scripts

| Script           | Description                      |
| ---------------- | -------------------------------- |
| `pnpm dev`       | Start dev server with hot reload |
| `pnpm start`     | Start production server          |
| `pnpm build`     | Build static UI assets           |
| `pnpm test`      | Run tests                        |
| `pnpm typecheck` | Type check without emitting      |

## API Endpoints

### Agent Routes (`/agents/*`)

| Method | Path                   | Description                     |
| ------ | ---------------------- | ------------------------------- |
| PUT    | `/agents/:name`        | Create agent session            |
| POST   | `/agents/:name`        | Send message to agent           |
| GET    | `/agents/:name`        | Subscribe to agent events (SSE) |
| DELETE | `/agents/:name`        | Delete agent session            |
| HEAD   | `/agents/:name`        | Check if agent exists           |
| GET    | `/agents/__registry__` | Subscribe to agent registry     |

### Stream Routes (`/streams/*`)

| Method | Path       | Description      |
| ------ | ---------- | ---------------- |
| GET    | `/streams` | List all streams |

### Other

| Method | Path             | Description       |
| ------ | ---------------- | ----------------- |
| GET    | `/`              | Redirect to `/ui` |
| GET    | `/platform/ping` | Health check      |

## Directory Structure

```
apps/daemon/
├── agents/pi/           # Pi SDK adapter and event types
├── event-stream/        # Effect-based stream management
│   ├── stream.ts        # Core stream implementation
│   ├── stream-manager.ts # Multi-stream orchestration
│   ├── storage.ts       # File-system persistence
│   └── types.ts         # Branded types (StreamName, Offset, etc.)
├── ui/                  # React UI components
├── index.ts             # Hono app definition
├── server.ts            # HTTP server entry point
└── vite.config.ts       # Vite dev server config
```

## Data Storage

Events are persisted to `.iterate/streams/` as JSON files, one file per stream. The storage layer uses Effect's FileSystem service for cross-platform compatibility.

## Related

- [`apps/cli`](../cli) - CLI that manages daemon lifecycle
