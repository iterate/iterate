---
state: in_progress
priority: high
size: medium
tags: [os, sandboxes, egress, websocket, interceptHttps, cloudflare, codex]
---

# Run stock Codex through sandbox WebSocket egress

PR: #1932, branch `experiment/sandbox-websocket-egress` (locally checked out as
`goal/container-intercept-wss`).

## Goal

1. Store an OpenAI API key in an OS project secret pinned to
   `https://api.openai.com`.
2. Give an unmodified Codex CLI sandbox only
   `CODEX_API_KEY=getSecret({ path: "/secrets/openai" })`.
3. Let Codex use its normal Responses WebSocket transport through container TLS
   interception, project egress policy, and server-side header substitution.
4. Make ordinary HTTP/1.1 WebSocket programs work without Iterate-specific
   proxy, CA, or transport code.

## Stock Codex fit

Released Codex derives `wss://api.openai.com/v1/responses` from its provider
base URL and sends `Authorization: Bearer ...` on the HTTP/1.1 upgrade. Direct
non-interactive auth reads `CODEX_API_KEY`. That is the header-placeholder
shape OS already supports; no frame rewriting is required. The evidence is
pinned to Codex 0.144.4's [OpenAI provider capability](https://github.com/openai/codex/blob/d72d669ca727a26765315ffe03db3dd2594d9b91/codex-rs/model-provider-info/src/lib.rs#L335-L363),
[WebSocket connection](https://github.com/openai/codex/blob/d72d669ca727a26765315ffe03db3dd2594d9b91/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L320-L350),
and [`CODEX_API_KEY` reader](https://github.com/openai/codex/blob/d72d669ca727a26765315ffe03db3dd2594d9b91/codex-rs/login/src/auth/manager.rs#L837-L848).

## Handshake root cause and minimal fix

The container interceptor presents the outbound handler's WebSocket response
as raw HTTP to the in-container client. Two handshake details matter:

1. `Sec-WebSocket-Accept` must be computed from the **sandbox client's**
   `Sec-WebSocket-Key`, not forwarded from the different upstream connection.
2. Supplying `Upgrade` or `Connection` in the Worker response duplicates the
   values injected by container intercept. Strict clients then see
   `websocket, websocket` and reject the handshake.

The final design has no application socket bridge:

| Piece                    | Responsibility                                                       |
| ------------------------ | -------------------------------------------------------------------- |
| Sandbox static outbound  | Route every intercepted request to the owning Project DO             |
| Project egress           | Apply policy and route secret-bearing requests                       |
| Secret `fetch()`         | Substitute pinned upgrade headers and open the upstream socket       |
| `websocket-handshake.ts` | Stamp the client-key Accept and strip duplicate/hop-specific headers |

Project and Secret DOs pass `Response.webSocket` through unchanged. Native
WebSocket transport owns frames. This deleted the original public
`secret.relayWebSocket()` API, Discord IDENTIFY machinery, and pair-pump code;
those expanded the security surface without helping Codex or the native close
failure.

## Deployed evidence

The real preview/Firecracker path proves all of the following without client
proxy or CA configuration:

- HTTPS and WSS see the Cloudflare Intercept CA and re-enter Project egress.
- A controlled public WSS fixture accepts only the secret-substituted bearer
  value while the sandbox retains the literal placeholder.
- Node's built-in `WebSocket` opens and exchanges server-first and client text
  frames.
- Node's built-in `WebSocket` sends a standard `1000` close that reaches the
  fixture with its exact reason.
- released `ws@8.21.0` negotiates a subprotocol and exchanges server-first,
  text, and binary frames.
- released `ws` sends its close frame with an exact non-default code and reason.
- the same fixture, reached directly outside the container, completes the
  reciprocal close with the exact code and reason.
- released `ws@8.21.0` receives that exact reciprocal close through both the
  bare Project path and the authenticated Secret DO path.

The exact released Codex proof is separate because its npm package is about
350 MB unpacked and the complete turn is billable. With
`OS_E2E_STOCK_CODEX_WEBSOCKET=1`, the test installs unmodified
`@openai/codex@0.144.4`, writes Doppler's OpenAI key to a project secret, gives
the sandbox only the placeholder, and requires the full JSONL turn with no
HTTP-fallback warning and exactly one audited secret use.

Final bridge-free deployment evidence on 2026-07-14, worker version
`7951b2cc-2373-4467-9ac1-d0051882ec03`:

- mandatory Firecracker HTTPS + Node global WebSocket + `ws@8.21.0`: passed in
  34.0 seconds;
- opt-in stock `@openai/codex@0.144.4`: passed in 96.3 seconds; and
- OS unit suite: 1,381 passed, 2 skipped.

The Codex test is intentionally not part of ordinary preview CI. The 96.3
second result above was the earlier controlled-fixture handshake proof; the
final opt-in test now codifies the stronger live whole-turn smoke below.

### Live OpenAI whole-turn smoke

A separate billable smoke on 2026-07-14 used the Doppler
`APP_CONFIG_OPEN_AI_API_KEY` only to write a project secret pinned to
`https://api.openai.com`. A fresh Firecracker sandbox received only the
literal `CODEX_API_KEY=getSecret({ path: "..." })` placeholder and ran
unmodified `codex-cli 0.144.4` with `codex exec --json --ephemeral`.

The complete turn passed in 26.3 seconds after installation:

```jsonl
{"type":"thread.started","thread_id":"019f6014-12b2-7b11-b524-caf2401da079"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ITERATE_WEBSOCKET_SMOKE_OK"}}
{"type":"turn.completed","usage":{"input_tokens":10228,"cached_input_tokens":0,"output_tokens":12,"reasoning_output_tokens":0}}
```

Workers Observability trace `ec506ffe0a6c7366e0d7eb7b05bb65c8`
correlates that same thread to an HTTP/1.1 `GET /v1/responses` from
`codex_exec/0.144.4` with `Connection: Upgrade`, `Upgrade: websocket`, and
`openai-beta: responses_websockets=2026-02-06`. No OpenAI POST appeared in the
trace window, and Codex emitted no `falling back to HTTP` warning. The secret
audit advanced exactly once with `lastUsedUrl` equal to
`https://api.openai.com/v1/responses`; a post-turn container read still saw
only the placeholder. The sandbox was then destroyed.

## Blocking compatibility defect

The stock sandbox's built-in Node `WebSocket` never receives `close`, despite
the fixture having received its standard `1000` close with the exact reason and
sent the acknowledgement. The direct control passes, and released `ws`
receives the exact acknowledgement through the same bare fixture and the
authenticated Secret DO path. The transport can therefore carry the close;
this is specifically a built-in-client/interceptor interaction.

Pair-pump variants at every application boundary were deployed and tested;
none repaired the built-in behavior, so retaining them only adds ownership and
lifetime complexity. The pinned upstream
[workerd container-client WebSocket test](https://github.com/cloudflare/workerd/blob/e4c3d8b4557f6dc5b63315b45a61a4dd8a92a944/src/workerd/server/tests/container-client/test.js#L1180-L1246)
validates echo and calls `close()`, but does not wait for or assert the
reciprocal close event—the same coverage hole.

Therefore the PR can truthfully claim strict handshake success and duplex
data, complete released-`ws` close semantics, and stock Codex negotiation. It
cannot yet claim that **any normal WebSocket program just works**: a program
using Node's built-in client can hang while awaiting close. That generic
contract remains blocked until the built-in client passes the same deployed
exact-close assertion.

## Verification commands

```bash
pnpm --dir apps/os exec vitest run \
  src/domains/secrets/websocket-handshake.test.ts \
  src/domains/secrets/credential-fetch.test.ts

pnpm --dir apps/os exec vitest run --config e2e/vitest.config.ts \
  e2e/vitest/sandbox-egress.e2e.test.ts

doppler run --config preview_8 -- env OS_E2E_STOCK_CODEX_WEBSOCKET=1 \
  pnpm --dir apps/os exec vitest run --config e2e/vitest.config.ts \
  e2e/vitest/sandbox-codex-websocket.e2e.test.ts
```

## Remaining

1. File/escalate the isolated built-in/interceptor close regression with the
   direct-control and released-`ws` comparison.
2. After the compatibility fix, make reciprocal close code/reason a mandatory
   deployed assertion before declaring the generic transport contract green.

The branch's targeted lint, formatting, and diff checks pass. OS typecheck is
currently blocked by pre-existing duplicate React type errors in
`packages/ui/src/components/ai-elements/message.tsx` and
`packages/ui/src/components/spinner.tsx`; no changed file reports a type error.

## Non-goals

- gRPC or HTTP/2 interception;
- browser WebSocket custom `Authorization` headers;
- first-frame credential injection;
- generic query-string substitution;
- a live billable OpenAI turn in CI.

## Key files

| Path                                                                            | Role                                                 |
| ------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `apps/os/src/domains/secrets/websocket-handshake.ts`                            | Final downstream handshake reconstruction            |
| `apps/os/src/domains/secrets/credential-fetch.ts`                               | Preserve sockets across sanitized credential fetches |
| `apps/os/src/domains/projects/project-durable-object.ts`                        | Project policy and secret routing                    |
| `apps/os/src/domains/sandboxes/cloudflare/cloudflare-sandbox-durable-object.ts` | Container outbound handoff                           |
| `apps/os/e2e/vitest/sandbox-egress.e2e.test.ts`                                 | Mandatory deployed HTTPS + small-client WSS proof    |
| `apps/os/e2e/vitest/sandbox-codex-websocket.e2e.test.ts`                        | Opt-in exact released-Codex proof                    |
| `apps/os/docs/sandbox-websocket-egress.md`                                      | Product contract, setup, proof, and limitation       |
