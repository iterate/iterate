# Sandbox & secret WebSocket egress

Outbound `wss://` from sandboxes and from secrets goes through the same project
egress door as HTTPS. Containers MITM TLS (`interceptHttps`); the Project DO
applies policy and secret rules; accepted upgrades are **pair-bridged**
(`WebSocketPair`) so the client leg is owned in platform code.

## Does real WebSocket work?

**Yes.** Preview Firecracker sandboxes and local containers (2026-07-13) complete
full duplex under the Cloudflare Intercept CA against
`wss://ws.postman-echo.com/raw` (Node global `WebSocket` open → send → echo).
Peer cert issuer is the MITM CA; the HTTP 101 carries a single
`Upgrade: websocket` / `Connection: Upgrade` pair plus a client-key
`Sec-WebSocket-Accept` (container intercept injects hop-by-hop Upgrade headers;
outbound stamps Accept only so undici does not see duplicates).

gRPC/HTTP2 under intercept is a separate limitation
([containers#195](https://github.com/cloudflare/containers/issues/195));
HTTP/1.1 WebSocket upgrade is fine.

## Auth shapes

| Shape                                                            | Where the credential rides | API                                                                             |
| ---------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------- |
| Header on upgrade                                                | `Authorization`, etc.      | `secret.fetch(upgradeRequest)` with `getSecret(...)` in headers                 |
| Subprotocol on upgrade                                           | `Sec-WebSocket-Protocol`   | Same (header substitution)                                                      |
| First app frame (Discord IDENTIFY, GraphQL `connection_init`, …) | JSON text after open       | `secret.relayWebSocket({ identify })` — **trusted** IDENTIFY; no frame scanning |
| Query-string token                                               | `?token=`                  | Not generic substitution; open URL inside Secret DO if needed                   |

**Frames are never scanned for `getSecret(...)`** (ADR 0005). Frame-carried
tokens are sent only by trusted Secret DO code in `relayWebSocket`.

### Header upgrade (example)

```ts
const res = await itx.secrets.get("/secrets/openai").fetch(
  new Request("https://api.openai.com/v1/realtime", {
    headers: {
      Upgrade: "websocket",
      Connection: "Upgrade",
      Authorization: 'Bearer getSecret({ path: "/secrets/openai" })',
    },
  }),
);
// res.webSocket after pair-bridge
```

### Discord / IDENTIFY relay (example)

```ts
await itx.secrets.get("/secrets/discord-bot").update({
  egress: { urls: ["https://dummy-petshop.iterate.com"] },
  material: "access-token-string",
});

const res = await itx.secrets.get("/secrets/discord-bot").relayWebSocket({
  url: "wss://dummy-petshop.iterate.com/gateway",
  identify: {}, // wait for op:"hello", send { op:"identify", token }
});
// res.webSocket is past IDENTIFY (hello is still forwarded for heartbeat
// params; the token IDENTIFY was already sent by the Secret DO)
```

Custom frame template: `identify.frame` with `"$token"` placeholders;
`identify.tokenField` for structured material; `identify.waitForOp: null` to
send IDENTIFY immediately after open.

## Implementation map

| Piece                                 | Role                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `sandboxOutboundFor`                  | All container HTTP(S) → Project DO `fetch`                                               |
| Project `#egress`                     | Policy, secrets, then `maybeBridgeWebSocketResponse`                                     |
| `websocket-bridge.ts`                 | `WebSocketPair` + half-open frame pump                                                   |
| Secret `fetch`                        | Handshake placeholder substitution + bridge                                              |
| Secret `relayWebSocket`               | Trusted IDENTIFY then bridge (routed via DO **fetch** so `Response.webSocket` transfers) |
| `credential-fetch` `sanitizeResponse` | Preserves workerd `webSocket` slot across hops                                           |
| Approval hold                         | **Denies** WebSocket upgrades (cannot buffer/hold a handshake)                           |

## Sandbox e2e (opt-in)

Cold sandbox + public `wss` is slow (~50s+) and is **opt-in** so preview wall
clock stays inside budget:

```bash
RUN_SANDBOX_WS_E2E=1 pnpm --dir apps/os exec vitest run \
  --config e2e/vitest.config.ts \
  e2e/vitest/sandbox-websocket-egress.e2e.test.ts
```

Requires a deployed OS (`APP_CONFIG_BASE_URL` not localhost). Proves echo over
`wss://ws.postman-echo.com/raw` from a lite sandbox.

## Manual local probe

```bash
OS_SANDBOX_CONTAINER_LOCAL_DEV=true pnpm --dir apps/os dev start --detach
# then itx run against localhost with a script that creates a sandbox and:
#   node -e 'const ws=new WebSocket("wss://ws.postman-echo.com/raw"); ...'
```

## Known limitations

- Long-lived bridges pin Project (and Secret, on secret path) DO isolates as
  non-hibernatable pumps; no per-project socket cap yet.
- Secret-header upgrade e2e and petshop `/gateway` `relayWebSocket` e2e are
  still follow-ups.
- Query-string token APIs need a trusted URL builder, not generic query rewrite.
- Tool-specific failures (e.g. wrangler remote tail) may still need host-specific
  repros even though generic WSS works.
