# Daemon

A local daemon for managing coding agents with a web UI. Built with Hono (server) and React + TanStack Router (client). API layer uses oRPC.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Development Mode                             │
│                                                                      │
│  ┌────────────────────────┐      ┌─────────────────────────────┐    │
│  │   Vite Dev Server      │      │    Hono API Server          │    │
│  │   (port 3000)          │      │    (port 3001)              │    │
│  │                        │      │                             │    │
│  │  - React SPA (HMR)     │ ───► │  - /api/orpc/*              │    │
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
│  │  - /api/orpc/*                                                │   │
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
apps/daemon/
├── client/              # React SPA (TanStack Router)
│   ├── components/      # UI components
│   ├── hooks/           # React hooks
│   ├── integrations/    # oRPC and TanStack Query setup
│   ├── routes/          # File-based routes
│   ├── main.tsx         # Client entry point
│   └── router.tsx       # Router configuration
├── server/              # Hono API server
│   ├── routers/         # API route handlers
│   ├── orpc/            # oRPC router and procedures
│   ├── db/              # Database schema and client
│   ├── utils/           # Shared utilities (Hono app, WebSocket)
│   └── app.ts           # Main Hono app with middleware
├── server.ts            # Production server entry point
├── index.html           # SPA HTML template
└── vite.config.ts       # Vite configuration
```

## API Endpoints

### oRPC (`/api/orpc/*`)

All application data is accessed via oRPC procedures.

### WebSocket (`/api/pty`)

PTY terminal WebSocket endpoint for interactive terminal sessions.

| Query Param | Description                    |
| ----------- | ------------------------------ |
| `cols`      | Terminal columns (default: 80) |
| `rows`      | Terminal rows (default: 24)    |

### Health Check

| Method | Path          | Description  |
| ------ | ------------- | ------------ |
| GET    | `/api/health` | Health check |

## Data Storage

- SQLite database at `./db.sqlite`
