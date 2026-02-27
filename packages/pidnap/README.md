# pidnap

Process manager with init-system capabilities for tasks, cron jobs, and long-running processes. Meant to be used together with `tini`

## Install

```bash
pnpm install
```

## Run as init system

```bash
tini -sg -- pidnap init
```

By default, this looks for `pidnap.config.ts` in the current directory. To use a different config file:

```bash
pidnap init --config path/to/config.ts
```

## CLI

```bash
pidnap status
pidnap processes list
pidnap processes add --name api --definition '{"command":"node","args":["server.js"]}'
pidnap processes restart api
pidnap crons list
pidnap tasks list
pidnap tasks remove task-1
```

## HTTP API

When running as init (`pidnap init`), an ORPC server starts on port 9876 (configurable).

**Important**: All RPC endpoints use the `/rpc` prefix:

- Health check: `GET http://localhost:9876/rpc/health`
- Processes: `POST http://localhost:9876/rpc/processes.list`, etc.

The TypeScript client handles this automatically:

```ts
import { createClient } from "pidnap/client";
const client = createClient(); // defaults to http://localhost:9876/rpc
```

When creating a client with a custom base URL, include the `/rpc` suffix:

```ts
const client = createClient("http://localhost:9876/rpc");
```

## Event publishing (optional)

Pidnap can publish process state change events in the events-service `appendStreamEvents` shape:

```ts
const callbackURL = process.env.PIDNAP_EVENTS_CALLBACK_URL?.trim();

export default defineConfig({
  events: {
    callbackURL: callbackURL ?? "http://127.0.0.1:19010/orpc/appendStreamEvents",
    path: "/pidnap",
    timeoutMs: 2000,
  },
});
```

Run with a callback target:

```bash
PIDNAP_EVENTS_CALLBACK_URL=http://127.0.0.1:19010/orpc/appendStreamEvents pidnap init
```

Posted body:

```json
{
  "path": "/pidnap",
  "events": [
    {
      "type": "https://events.iterate.com/pidnap/process/state-changed",
      "payload": {
        "name": "worker",
        "previousState": "idle",
        "state": "running"
      },
      "version": "1"
    }
  ]
}
```

Current event types:

- `https://events.iterate.com/pidnap/process/state-changed`

## Architecture

- CLI: `src/cli.ts` loads config, starts RPC server (with `/rpc` prefix), boots manager
- Core: `src/manager.ts` orchestrates tasks, crons, and restarting processes
- Runtime: `src/lazy-process.ts` executes processes; `src/restarting-process.ts` handles restarts
- Scheduling: `src/cron-process.ts` manages cron jobs with retry/queue
- Env: `src/env-manager.ts` loads `.env` + watches for reloads
- API: `src/api/contract.ts` defines ORPC contract, `src/api/server.ts` implements it, `src/api/client.ts` creates typed client

## Development

```bash
pnpm run typecheck
pnpm run lint
pnpm run format
pnpm test
```
