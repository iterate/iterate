## `apps/agents`

TanStack Start app + Cloudflare Worker for stream-driven agent processors.

The current agent stack is split into independent stream processor runner
Durable Objects:

- `WebchatStreamProcessorRunner` consumes `events.iterate.com/webchat/*` and
  renders webchat traffic into model-visible agent input.
- `AgentStreamProcessorRunner` consumes curated agent input and owns LLM
  scheduling/status events.
- `CodemodeStreamProcessorRunner` consumes assistant input, executes codemode
  blocks through injected runtime dependencies, and may emit webchat responses.

`ChildStreamAutoSubscriber` is still an `agents` package Durable Object because
it uses the existing outbound WebSocket routing for prefix-level discovery. It
watches the configured stream prefix, then subscribes the three runner Durable
Objects to each new descendant stream.

### Manual WebSocket debugging

Runner WebSocket callbacks are explicit app routes:

```text
ws://127.0.0.1:<PORT>/api/webchat-stream-processor-runner/<instance>/websocket?streamPath=/agents/demo
ws://127.0.0.1:<PORT>/api/agent-stream-processor-runner/<instance>/websocket?streamPath=/agents/demo
ws://127.0.0.1:<PORT>/api/codemode-stream-processor-runner/<instance>/websocket?streamPath=/agents/demo
```

Inbound frames use the events stream socket protocol
(`StreamSocketFrame` in `@iterate-com/events-contract`): wrap stream events as
`{ "type": "event", "event": { ...full Event... } }`.

The old monolithic `IterateAgent` class has been removed. Any e2e tests that
still target `/agents/iterate-agent/...` are intentionally skipped while their
coverage is rebuilt around the runner architecture.

### Production / Tunnel Callbacks

`events.iterate.com` opens outbound WebSockets to the runner callback URLs
above. Local probing uses `ws://`; Semaphore / Cloudflare tunnel URLs use
`wss://` with the same paths.

### Codemode + HTTP

Codemode runs in a nested worker; outbound HTTP uses `globalOutbound` →
`CodemodeOutboundFetch` → host `fetch` (including
`APP_CONFIG_EXTERNAL_EGRESS_PROXY`). Processor implementations should receive
runtime dependencies such as code executors, AI bindings, or HTTP clients as
dependencies rather than importing Cloudflare bindings directly.

### Doppler: Missing Env Vars

The CLI caches decrypted secrets under `~/.doppler/fallback/`. If new secrets
were added in the dashboard after that cache was written, `doppler run` can
inject an outdated set. Scripts use `doppler run --no-cache --` so each run
fetches the current secret bundle. To clear bad cache manually, remove the
relevant files under `~/.doppler/fallback/` or run once with `--no-cache`.

### E2E: Semaphore Tunnel + Local Dev Server

Order is fixed: tunnel lease → local port from that lease → Alchemy dev on that
port → `cloudflared`.

1. `useCloudflareTunnelLease` gets a Semaphore lease with a stable public host
   and assigned local port.
2. `useDevServer({ port: tunnelLease.localPort, command: "pnpm", args:
["exec", "tsx", "./alchemy.run.ts"], ... })` starts Alchemy/Vite on that
   local port.
3. `useCloudflareTunnel({ token, publicUrl })` opens `cloudflared` so the public
   URL hits the local listener.

See `e2e/vitest/forwarded-events.e2e.test.ts` for the currently-live webhook
shape and `e2e/vitest/pull-runner.e2e.test.ts` for processor runner coverage.

### Event Stream Terminal UI

The `stream-tui` CLI is the seed of a fuller agent TUI. Keep the implementation
small and boring, but do not invent abstractions that OpenTUI or OpenCode have
already solved.

**References**

- OpenTUI owns terminal primitives: `ScrollBoxRenderable`, `InputRenderable`,
  `TextareaRenderable`, `SelectRenderable`, React `createRoot`, plugin slots,
  and the official keymap package.
- OpenCode is the command-menu reference. Its command shape is plain data:
  `title`, `value`, `description`, `category`, `keybind`, `slash`, `hidden`,
  `enabled`, `onSelect`.
- `pilotty` is the agent/manual automation driver for OpenTUI sessions.

**Language**

- **Command**: a local TUI action represented as plain data.
- **Command router**: the local oRPC-style router that defines TUI commands.
- **Slash command**: a command invoked from the input by `/name`.
- **Exclamation command**: input beginning with `!`; pass it through as agent
  input.
- **App context**: React-accessible context for the current TUI session.
- **`streamApi`**: a stream-scoped wrapper around the events oRPC client.
- **Reduced stream state**: the result of processing stream events.

**Testing**

- Put reducer behavior in normal unit tests.
- Run checked-in Stream TUI workflow specs with `pnpm --dir apps/agents
test:e2e:tui`.
- Use `pilotty` for agent-run smoke checks and bug reproduction against a real
  PTY.
