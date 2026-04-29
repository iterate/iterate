## `apps/agents`

TanStack Start app + Cloudflare Worker; Agents SDK routes `/agents/<agent-class-kebab>/<instance>` WebSockets to Durable Object agent classes (e.g. `IterateAgent` → `iterate-agent`).

### Manual WebSocket debugging (IterateAgent)

**URL:** `ws://127.0.0.1:<PORT>/agents/iterate-agent/<instanceName>` (local dev) or `wss://<host>/agents/iterate-agent/<instanceName>` (deployed / tunneled). `<PORT>` comes from `pnpm dev` / Alchemy output (often `5173` or `$PORT`). Instance name is arbitrary per connection.

**Inbound frames** use the events stream socket protocol (`StreamSocketFrame` in `@iterate-com/events-contract`): wrap stream events as `{ "type": "event", "event": { ... } }`. For codemode, `IterateAgent` accepts inner events shaped like `codemode-block-added` with `{ "script": "<async arrow body>" }`.

**CLI tools**

- **`websocat`** — best for piping a single JSON line (install: [websocat](https://github.com/vi/websocat) via `brew install websocat` or `cargo install websocat`). Example (local dev):

```bash
printf '%s\n' '{"type":"event","event":{"type":"codemode-block-added","payload":{"script":"async () => ({ ok: true })"}}}' \
  | websocat ws://127.0.0.1:5173/agents/iterate-agent/manual-test
```

- **`wscat`** — interactive REPL for typing frames (no global install: `npx wscat -c "ws://127.0.0.1:5173/agents/iterate-agent/manual-test"`). After connect, paste one line of JSON and Enter.

On connect, the Agents SDK may send its own protocol messages first (`cf_agent_identity`, `cf_agent_state` if any, `cf_agent_mcp_servers`, etc.). When Events connects outbound to this agent as a stream subscriber, it ignores those frames so they do not interfere with stream-socket traffic.

**Scripting without extra CLIs:** Node 22+ exposes `globalThis.WebSocket` — use `addEventListener("open", …)` and `send()` the same JSON string as above.

### Production / tunnel callbacks

`events.iterate.com` opens an **outbound** WebSocket to your **public** `wss://…/agents/iterate-agent/…` callback and sends the same `{ type: "event", event: <Event> }` frames. Local probing uses `ws://`; Semaphore / Cloudflare tunnel URLs use `wss://` with the same path.

### Codemode + HTTP

Codemode runs in a nested worker; outbound HTTP uses `globalOutbound` → `CodemodeOutboundFetch` → host `fetch` (including `APP_CONFIG_EXTERNAL_EGRESS_PROXY`). Scripts use normal **`async () => { ... }`** and global **`fetch(...)`** (same as the nested worker’s outbound).

### Doppler: missing env vars (including `SEMAPHORE_*`)

The CLI caches decrypted secrets under `~/.doppler/fallback/`. If new secrets were added in the dashboard (e.g. inherited from `_shared`) **after** that cache was written, `doppler run` can inject an **outdated** set — `doppler secrets get` still works because it hits the API. **Fix:** scripts use `doppler run --no-cache --` so each run fetches the current secret bundle. To clear bad cache manually: remove the relevant files under `~/.doppler/fallback/` or run once with `--no-cache`.

### E2E: Semaphore tunnel + local dev server

Order is fixed: **tunnel lease → local port from that lease → Alchemy dev on that port → `cloudflared`**.

1. `useCloudflareTunnelLease` — Semaphore lease; includes `localPort` from the lease `service` URL (where the tunnel will forward).
2. `useDevServer({ port: tunnelLease.localPort, command: "pnpm", args: ["exec", "tsx", "./alchemy.run.ts"], ... })` — same env as `pnpm test:e2e` (already `doppler run`), so **no nested `doppler run`** (which could override `PORT`). Sets `PORT` + `HOST=127.0.0.1` and clears inherited `CI` so Alchemy/Vite stay long-running.
3. `useCloudflareTunnel({ token, publicUrl })` — run `cloudflared` so the public URL hits that listener.

See `e2e/vitest/forwarded-events.e2e.test.ts` and `iterate-agent.e2e.test.ts`.

**`iterate-agent` e2e** is skipped in default `pnpm test:e2e` until you opt in with `AGENTS_E2E_ITERATE_AGENT=1` (see `pnpm test:e2e:iterate-agent`). It exercises the real Events host → outbound WebSocket → `IterateAgent` path; deploy `apps/events` so subscriber delivery matches what the test expects.

### Inbound frames

`IterateAgent.onMessage` validates inbound frames with `StreamSocketFrame` from `@iterate-com/events-contract`, which requires the full `Event` shape (`streamPath`, `offset`, `createdAt`). Frames without those fields are silently dropped (logged as `not-stream-socket-frame`) — there is no loose-parse fallback.

### Event stream terminal UI

The `stream-tui` CLI is the seed of a fuller agent TUI. Keep the implementation small and boring, but do not invent abstractions that OpenTUI or OpenCode have already solved.

**References**

- OpenTUI owns terminal primitives: `ScrollBoxRenderable`, `InputRenderable`, `TextareaRenderable`, `SelectRenderable`, React `createRoot`, plugin slots, and the official keymap package.
- OpenCode is the command-menu reference. Its command shape is plain data: `title`, `value`, `description`, `category`, `keybind`, `slash`, `hidden`, `enabled`, `onSelect`. Copy the model, not the Solid-specific implementation.
- `pilotty` is the agent/manual automation driver for OpenTUI sessions. Use it to spawn a named PTY session, wait for visible text, type, press keys, snapshot text, resize, then kill the session.
- Microsoft TUI Test is the stronger candidate for checked-in Playwright-style workflow specs. Termless is the stronger candidate for terminal rendering invariants such as sticky scroll, wrapping, cursor state, and colours.

**Language**

- **Command**: a local TUI action represented as plain data. Commands may switch views, append canned events, call stream RPCs, or prefill input for commands that require arguments.
- **Command router**: the local oRPC-style router that defines TUI commands. It is the source of truth for command hierarchy, input schemas, handlers, and TUI metadata.
- **Slash command**: a command invoked from the input by `/name`. Slash commands are local TUI commands only.
- **Exclamation command**: input beginning with `!`. Do not interpret this in the TUI; pass it through as agent input so the server-side agent can process it.
- **Slash autocomplete**: the inline command picker shown above the input when the user types `/`.
- **App context**: the React-accessible context for the current TUI session. It owns the current stream path, reduced stream state, view setters, input helpers, and scoped `streamApi`.
- **Command invocation**: the extra input supplied when a command runs, such as the slash command's raw argument string.
- **`streamApi`**: a stream-scoped wrapper around the events oRPC client. It defaults appends to the current stream and resolves dot-relative stream paths against that stream.
- **View**: local TUI navigation state such as `feed`, `state`, `commands`, or `streams`. View selection is not part of the stream reducer.
- **Reduced stream state**: the result of processing stream events. It is not just feed items; it may also include status such as whether an LLM request is in progress.

**Settled design**

- Use one local command router until independently-owned panels or plugins need dynamic registration.
- App-wide services live in app context, not in a command-only context. React components and command handlers should reach the same `streamApi` through that context.
- All command-menu commands should be local oRPC-style procedures. They receive app context plus a command invocation object and should not reach into random module globals.
- Use our own TUI command metadata, not `trpc-cli` metadata, as the source of truth. Borrow useful ideas from `trpc-cli` metadata where they fit, such as positional fields and aliases.
- Preserve router hierarchy so command discovery can later show nested groups instead of only a flat list.
- Commands can inspect reduced stream state read-only and mutate the TUI through named app-context functions.
- Commands should use `context.streamApi.append({ event, streamPath? })` for appends. Omit `streamPath` for the current stream; pass an absolute path for another stream; pass a dot-relative path to target a child/sibling stream.
- Command procedures do not need a shared result envelope. Use oRPC/Zod validation and oRPC errors for failures; use app context for UI effects such as toasts, status text, prefilled input, and view changes.
- Slash commands and slash autocomplete are the main front doors into command records. Avoid terminal-level shortcut dependencies until they are proven reliable across Ghostty, tmux, Superset, and plain terminals.
- Canonical slash command names follow the local oRPC-style hierarchy, for example `/view.state`, `/stream.open`, and `/feed.expand`. Short aliases like `/state`, `/open`, and `/m` are compatibility sugar.
- Commands that require arguments should still appear in slash autocomplete; selecting them should prefill the input rather than fail silently.
- `Tab` changes major focus regions when slash autocomplete is closed: composer, main area, header. Inside the main area, use `Up`/`Down` to move between feed items and `Enter` to expand or collapse one.
- Most domain commands are thin wrappers around appending events. A smaller set calls the events oRPC API directly, such as stream reset/destroy, listing child streams, and navigating to another stream.
- Resetting a stream is a command and must expose whether child streams are also destroyed.
- `/streams` should switch to a streams view first. Later slash autocomplete can also expose streams as searchable command results.

**Testing**

- Put reducer behavior in normal unit tests.
- Run checked-in Stream TUI workflow specs with `pnpm --dir apps/agents test:e2e:tui`.
- Use `pilotty` for agent-run smoke checks and bug reproduction against a real PTY: startup layout, slash autocomplete, view switching, feed item expansion, resize, and quick snapshots.
- Use Microsoft TUI Test for checked-in black-box workflow specs. It launches the actual `pnpm --dir apps/agents cli stream-tui ...` command through a PTY.
- Prefer Termless for checked-in rendering specs once the spike proves it can model OpenTUI screen behavior accurately.
- In `pilotty`, put flags before positionals: `pilotty spawn --name stream-tui --cwd <repo> pnpm --dir apps/agents ...`.

**Current modules**

- `src/stream-tui/command-router.ts` owns the local oRPC-style command hierarchy, handlers, and TUI metadata.
- `src/stream-tui/command-discovery.ts` owns slash suggestion scoring and selection text.
- `src/stream-tui/command-invocation.ts` owns slash argument parsing and typed missing-argument errors.
- `src/stream-tui/stream-paths.ts` owns current-stream-relative path resolution.
- `src/stream-tui/navigation-state.ts` owns view/focus state transitions.
- `src/stream-tui/feed-formatting.ts` owns terminal feed formatting before OpenTUI renderables are created.
- `src/stream-tui/pilotty-command.ts` owns repeatable Pilotty command construction.
