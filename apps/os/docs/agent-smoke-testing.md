# Smoke-testing a real agent in a deployed environment

Use this to verify that an agent works end-to-end in prd, a preview slot, or a
running local dev server. The smoke uses the current itx CLI path rather than
the removed project oRPC procedures.

## Prerequisites

- The target environment is deployed and healthy.
- Run commands from `apps/os`.
- Use `--project os` with Doppler so `APP_CONFIG_BASE_URL` and
  `APP_CONFIG_ADMIN_API_SECRET` are available.

```bash
doppler run --project os --config prd -- pnpm cli itx --help
```

Swap `prd` for `preview_N` as needed. For local dev, start `pnpm dev` first and
pass `--base-url http://localhost:<port>` using the port in
`apps/os/.alchemy/dev-server.json`.

## Procedure

### 1. Create a throwaway project

```bash
doppler run --project os --config prd -- pnpm cli itx run \
  -e 'return await itx.projects.create({ slug: `agent-smoke-${Date.now()}` })'
```

Note the returned `id` and `slug`.

### 2. Run the one-turn agent smoke

```bash
doppler run --project os --config prd -- pnpm cli itx agent-smoke \
  --project <slug> \
  --agent-path /agents/smoke \
  --message "PING"
```

The command connects to the project over itx, appends
`events.iterate.com/agents/user-message-received` to the agent stream, then
waits with `itx.streams.get(...).waitForEvent(...)` until
`events.iterate.com/agents/web-message-sent` arrives. On success it prints one
JSON object containing the appended user event and the assistant response event.
On agent errors or timeout it exits non-zero.

For a custom timeout:

```bash
doppler run --project os --config prd -- pnpm cli itx agent-smoke \
  --project <slug> \
  --agent-path /agents/smoke \
  --message "PING" \
  --timeout-ms 180000
```

### 3. Inspect the stream manually

```bash
doppler run --project os --config prd -- pnpm cli itx run \
  --context <slug> \
  -e 'const stream = await itx.streams.get("/agents/smoke"); return await stream.getEvents({ beforeOffset: "end", limit: 100 })'
```

A healthy turn should include the user-message event, LLM request lifecycle
events, the generated itx script execution events, and the web-message-sent
event. Agent replies are itx JavaScript scripts; for the PING prompt a correct
reply usually calls:

```js
await itx.chat.sendMessage({ message: "PONG" });
```

### 4. Clean up

```bash
doppler run --project os --config prd -- pnpm cli itx run \
  -e 'return await itx.projects.remove({ id: "<prj_id>" })'
```

## Gotchas

- `--agent-path` must live under `/agents`.
- Use a fresh throwaway project. Messaging a real agent, especially a
  Slack-connected one, can send real user-visible messages.
- If the CLI cannot find the admin API secret, make sure the command is wrapped
  with `doppler run --project os --config <cfg> -- ...`.

## What this validates

- Project, Agent, Stream, and itx Durable Objects wake under the deployed code.
- Cross-script stream subscriptions deliver events.
- A real LLM turn starts, completes, runs the generated itx script, and sends a
  visible web-channel response.
