# Sandbox WebSocket egress

Outbound `wss://` from sandboxes uses the same project egress door as HTTPS.
The container proxy terminates TLS with the Cloudflare Intercept CA, the
Project Durable Object applies egress policy, and a referenced Secret Durable
Object substitutes placeholders in the HTTP/1.1 upgrade before opening the
upstream socket.

## Codex CLI

The stock Codex CLI's built-in OpenAI provider supports the Responses
WebSocket transport. It derives `wss://api.openai.com/v1/responses` from the
normal API base URL and sends `Authorization: Bearer <api key>` on the upgrade.
It does not put the API key in an application frame. These claims are pinned to
Codex 0.144.4's [OpenAI provider capability](https://github.com/openai/codex/blob/d72d669ca727a26765315ffe03db3dd2594d9b91/codex-rs/model-provider-info/src/lib.rs#L335-L363),
[WebSocket connection](https://github.com/openai/codex/blob/d72d669ca727a26765315ffe03db3dd2594d9b91/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L320-L350),
and [`CODEX_API_KEY` reader](https://github.com/openai/codex/blob/d72d669ca727a26765315ffe03db3dd2594d9b91/codex-rs/login/src/auth/manager.rs#L837-L848).

That maps directly onto the sandbox secret model:

```ts
const secretPath = "/secrets/openai";

await itx.secrets.get(secretPath).update({
  egress: { urls: ["https://api.openai.com"] },
  material: openAiApiKey,
});

await itx.sandboxes.create({
  name: "codex",
  instanceType: "lite",
  env: {
    // Codex reads this environment variable for direct API-key auth. The
    // sandbox receives only the placeholder.
    CODEX_API_KEY: `getSecret({ path: "${secretPath}" })`,
  },
});
```

`OPENAI_API_KEY | codex login --with-api-key` is a persistence flow and is not
appropriate for a write-only placeholder. The stock sandbox image already
trusts the Intercept CA; clients need no proxy agent or custom CA setting.

## Secret boundary

Only the WebSocket handshake is subject to ordinary egress substitution:

- `Authorization` and other upgrade headers can carry `getSecret(...)`.
- URL-path placeholders work under the same restrictions as HTTP requests.
- Query-string placeholders are rejected. Application-frame placeholders are
  not substituted and are sent literally.
- Frames are opaque and are never scanned or rewritten.
- A substituted `Sec-WebSocket-Protocol` value is never returned to the
  sandbox. Secret-bearing subprotocol authentication is not supported.

The final container boundary reconstructs downstream handshake state. It
computes `Sec-WebSocket-Accept` from the sandbox client's key, strips upstream
extensions and hop-by-hop headers, and preserves a selected subprotocol only
when it exactly matches one the sandbox offered. Project and Secret Durable
Objects pass the native `Response.webSocket` through; there is no application
frame pump.

## Implementation map

| Piece                     | Responsibility                                                              |
| ------------------------- | --------------------------------------------------------------------------- |
| Sandbox `static outbound` | Route intercepted traffic to the owning Project DO                          |
| Project egress            | Apply allow/deny policy and route secret-bearing requests                   |
| Secret `fetch`            | Substitute pinned handshake headers or URL and open the upstream socket     |
| `websocket-handshake.ts`  | Rebuild the final client-key handshake without duplicate hop-by-hop headers |

## Verification

The mandatory deployed `sandbox-egress.e2e.test.ts` uses a real Firecracker
sandbox and no client-specific proxy or CA configuration. It proves:

- the container sees the Cloudflare Intercept CA;
- HTTPS and authenticated WSS both pass through Project egress;
- the sandbox retains the literal placeholder while the fixture sees the real
  secret and the secret-use audit advances;
- Node's built-in `WebSocket` completes a bare WSS handshake and duplex text
  exchange; and
- released `ws@8.21.0` completes an authenticated handshake, negotiates a
  subprotocol, exchanges server-first, text, and binary frames, and receives
  the exact reciprocal close code and reason. A second `ws` run proves the
  same close behavior against the built-in client's bare fixture.

The released Codex package is about 350 MB unpacked and the whole-turn proof is
billable, so it is a separate explicit test rather than a cost added to every
preview. It reads Doppler's OpenAI key only to write a project secret, gives an
unmodified `@openai/codex@0.144.4` sandbox only the placeholder, and requires a
complete JSONL `codex exec` turn with no HTTP-fallback warning and exactly one
secret use. It is skipped unless explicitly enabled:

```bash
doppler run --config preview_8 -- env OS_E2E_STOCK_CODEX_WEBSOCKET=1 \
  pnpm --dir apps/os exec vitest run --config e2e/vitest.config.ts \
  e2e/vitest/sandbox-codex-websocket.e2e.test.ts
```

The fixture also has an outside-container control that proves its reciprocal
close code and reason are correct before the sandbox path is exercised.

## Known compatibility limitation: Node's built-in close event

The generic "any normal WebSocket program just works" contract is not yet
proven. The final deployed client matrix on 2026-07-14 showed:

1. outside-container Node WebSocket → client receives the fixture's exact
   reciprocal close;
2. in-container `ws@8.21.0` → the same bare fixture receives the exact close;
3. authenticated in-container `ws@8.21.0` → the Secret DO path also receives
   the exact close; but
4. the stock sandbox's built-in Node `WebSocket` exchanges frames and sends its
   standard `1000` close, yet does not report the reciprocal `close` event.

The mandatory test compares both clients against the same fixture and records
the built-in miss explicitly; the released `ws` result proves the transport
can carry the close frame. Pair bridges at the Project, Secret, and final
container boundary did not repair the built-in behavior, so the remaining
issue is a Node-built-in/container-interceptor interaction rather than a reason
to retain application frame pumps. Cloudflare's pinned
[workerd container-intercept test](https://github.com/cloudflare/workerd/blob/e4c3d8b4557f6dc5b63315b45a61a4dd8a92a944/src/workerd/server/tests/container-client/test.js#L1180-L1246)
exercises echo and calls `close()` but does not await or assert the close event.

Consequently, handshake and duplex data are proven, including stock Codex's
handshake, and released `ws` has complete close semantics. The stronger claim
that _any_ normal WebSocket program will transparently work is still false: a
program using Node's built-in client can wait until its own timeout. Product
green light for the generic contract requires the built-in client to pass the
same exact close assertion in the deployed regression.

Other boundaries remain: this is HTTP/1.1 WebSocket upgrade, not gRPC or
HTTP/2 interception and first-frame credential injection are not supported.
