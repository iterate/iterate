# Discord Daemon Bridge

Discord Gateway (WS) to daemon agents bridge.

## What it does

- Connects to Discord via gateway
- Forwards user messages to daemon via generic integration router
- Maintains per-thread `agentPath` and subscribes to state updates
- Exposes codemode endpoint for Discord actions: `POST /codemode`
- Keeps daemon generic: no Discord-specific daemon routes

## Required env

- `DISCORD_TOKEN`

## Optional env

- `DAEMON_BASE_URL` (default: `http://localhost:3001`)
- `PUBLIC_BASE_URL` (default: `http://localhost:11001`)
- `PORT` (default: process manager assigned port)

## HTTP endpoints

- `GET /health`
- `POST /agent-change-callback`
- `POST /codemode`

## Codemode

- Use `POST http://localhost:11001/codemode`
- Body: `{ "agentPath": "...", "code": "return thread.id" }`
- Agent path format: `/agent/:agentType/:id` (Discord uses `/agent/discord/:id`)
- Bindings: `thread`, `client`, `session`, `globalThis`
- Full guide: `DISCORD.md`

## Run

```bash
pnpm --filter @iterate-com/discord start
```
