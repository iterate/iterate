# Daemon2

A local daemon for managing coding agents with a web UI. Built with Hono (server) and React + TanStack Router (client).

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Development Mode                             │
│                                                                      │
│  ┌────────────────────────┐      ┌─────────────────────────────┐    │
│  │   Vite Dev Server      │      │    Hono API Server          │    │
│  │   (port 3000)          │      │    (port 3001)              │    │
│  │                        │      │                             │    │
│  │  - React SPA (HMR)     │ ───► │  - /api/trpc/*              │    │
│  │  - Proxies /api/*      │ ws   │  - /api/health              │    │
│  │                        │      │  - /api/pty (WebSocket)     │    │
│  └────────────────────────┘      └─────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                         Production Mode                              │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    Hono Server (port 3001)                    │   │
│  │                                                               │   │
│  │  - Serves static SPA from ./dist                              │   │
│  │  - /api/trpc/*                                                │   │
│  │  - /api/health                                                │   │
│  │  - /api/pty (WebSocket for terminal)                          │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

## Scripts

| Script              | Description                                       |
| ------------------- | ------------------------------------------------- |
| `pnpm dev`          | Start both client (Vite) and server concurrently  |
| `pnpm dev:client`   | Start Vite dev server only                        |
| `pnpm dev:server`   | Start Hono API server with watch mode             |
| `pnpm build:client` | Build static SPA to ./dist                        |
| `pnpm start`        | Start production server (serves API + static SPA) |
| `pnpm test`         | Run tests                                         |
| `pnpm typecheck`    | Type check without emitting                       |

## Directory Structure

```
apps/daemon2/
├── client/              # React SPA (TanStack Router)
│   ├── components/      # UI components
│   ├── hooks/           # React hooks
│   ├── integrations/    # tRPC and TanStack Query setup
│   ├── routes/          # File-based routes
│   ├── main.tsx         # Client entry point
│   └── router.tsx       # Router configuration
├── server/              # Hono API server
│   ├── routers/         # API route handlers
│   ├── trpc/            # tRPC router and procedures
│   ├── db/              # Database schema and client
│   ├── utils/           # Shared utilities (Hono app, WebSocket)
│   └── app.ts           # Main Hono app with middleware
├── server.ts            # Production server entry point
├── index.html           # SPA HTML template
└── vite.config.ts       # Vite configuration
```

## API Endpoints

### tRPC (`/api/trpc/*`)

All application data is accessed via tRPC procedures.

### WebSocket (`/api/pty`)

PTY terminal WebSocket endpoint for interactive terminal sessions.

| Query Param   | Description                          |
| ------------- | ------------------------------------ |
| `cols`        | Terminal columns (default: 80)       |
| `rows`        | Terminal rows (default: 24)          |
| `tmuxSession` | Optional tmux session name to attach |

### Health Check

| Method | Path          | Description  |
| ------ | ------------- | ------------ |
| GET    | `/api/health` | Health check |

## Data Storage

- SQLite database at `./db.sqlite`
- Tmux socket at `./.iterate/tmux.sock`
