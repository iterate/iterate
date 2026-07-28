# Sandbox WebSocket egress

Sandbox `wss://` uses the HTTPS interception path: the container proxy
terminates TLS with the Cloudflare Intercept CA, Project egress applies policy,
and a referenced Secret substitutes placeholders in the HTTP/1.1 upgrade.
Clients need no Iterate-specific proxy, CA, or transport code.

## Codex CLI

Stock Codex derives `wss://api.openai.com/v1/responses` from its OpenAI base URL
and sends `Authorization: Bearer <api key>` on the upgrade. This is pinned to
Codex 0.144.4's [provider capability](https://github.com/openai/codex/blob/d72d669ca727a26765315ffe03db3dd2594d9b91/codex-rs/model-provider-info/src/lib.rs#L335-L363),
[WebSocket connection](https://github.com/openai/codex/blob/d72d669ca727a26765315ffe03db3dd2594d9b91/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L320-L350),
and [`CODEX_API_KEY` reader](https://github.com/openai/codex/blob/d72d669ca727a26765315ffe03db3dd2594d9b91/codex-rs/login/src/auth/manager.rs#L837-L848).

```ts
const secretPath = "/secrets/openai";
await itx.secrets.get(secretPath).update({
  egress: { urls: ["https://api.openai.com"] },
  material: openAiApiKey,
});
await itx.sandboxes.get("/sandboxes/codex").create({
  instanceType: "lite",
  env: { CODEX_API_KEY: `getSecret("${secretPath}")` },
});
```

The sandbox receives only the placeholder. `codex login --with-api-key` is a
persistence flow and is unsuitable for a write-only placeholder.

## Contract

- Header and URL-path placeholders follow normal project egress rules.
- Query-string and application-frame placeholders are not substituted; frames
  remain opaque.
- Secret-bearing subprotocol authentication is unsupported: a substituted
  `Sec-WebSocket-Protocol` is never reflected to the sandbox.
- `websocket-handshake.ts` computes `Sec-WebSocket-Accept` from the sandbox
  client's key, removes hop-specific headers, and returns a selected protocol
  only when the client offered it.
- Project and Secret Durable Objects preserve the native `Response.webSocket`;
  there is no application frame pump.

## Verification

The mandatory deployed `sandbox-egress.e2e.test.ts` proves the Intercept CA,
HTTPS and WSS project routing, secret substitution without sandbox disclosure,
built-in Node duplex text, and released `ws@8.21.0` text/binary/subprotocol and
exact close semantics. An outside-container control validates the fixture.

The separate billable smoke installs unmodified `@openai/codex@0.144.4` and
requires a complete JSONL turn, no HTTP fallback, exactly one secret use, and
no key disclosure. It is opt-in because the package is large and the model call
costs money:

```bash
OS_E2E_STOCK_CODEX_WEBSOCKET=1 doppler run --config <preview_N> -- \
  pnpm --dir apps/os exec vitest run --config e2e/vitest.config.ts \
  e2e/vitest/sandbox-codex-websocket.e2e.test.ts
```

## Known Node limitation

The sandbox's built-in Node `WebSocket` exchanges frames and sends its `1000`
close, but does not report the reciprocal close event. The same deployed
fixture returns the exact code and reason to an outside-container client and to
`ws@8.21.0` through both bare and authenticated paths, so the transport can
carry the close frame. Pair pumps at application boundaries did not change the
result.

Cloudflare's pinned [container-intercept test](https://github.com/cloudflare/workerd/blob/e4c3d8b4557f6dc5b63315b45a61a4dd8a92a944/src/workerd/server/tests/container-client/test.js#L1180-L1246)
also exercises echo and calls `close()` without asserting the reciprocal event.
Until the deployed built-in-client assertion passes, claim transparent
handshake and duplex behavior broadly, full close semantics for `ws`, and stock
Codex support—not identical close behavior for every runtime.

This path covers HTTP/1.1 WebSocket upgrades, not gRPC, HTTP/2 interception, or
first-frame credential injection.
