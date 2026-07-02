# ITX capability demos

Two proofs of concept that show the same idea from opposite ends: a client
process can **provide a live capability into a project**, and the worker (or an
agent running inside it) then **calls that capability back over RPC** as if it
were local.

- **Blind relay egress** — the client provides a `dial()` TCP capability. Once
  installed, the worker carries **every** outbound request through the client's
  socket: it materializes any secret, runs TLS itself, and pushes only encrypted
  records down the wire. The client moves bytes; it never sees the HTTP request,
  the body, or the substituted secret.
- **Page debugging** — the client (a browser tab) provides a `debugPage()` DOM
  capability. The worker, or the demo page acting as an agent, drives that tab
  remotely: snapshot the DOM, click, fill, screenshot.

In both cases the shape is identical: `project.egress.useBlindRelayForSecretEgress(relay)`
and `connectPageTools(...)` each hand the project a `RpcTarget` that outlives the
call, and the project invokes it later. That symmetry is the point — ITX lets an
untrusted-to-the-worker client lend a narrow, live capability without the worker
having to trust the client with the payload, and without the client having to
trust the worker with its socket or its page.

Both demos live entirely in `apps/minimal-itx-v4`, each behind its own Durable
Object and route, so they can be deployed and torn down independently.

---

## Blind relay egress

Deployed playground:

```text
https://minimal-itx-v4-blind-relay-poc.iterate-dev-preview.workers.dev/playground
```

Open it, pick an ITX script button, read (or edit) the `async function run(itx)`
in the textarea, and click **Run**. The script runs server-side inside the
shared demo project. The page also hosts a small Durable Object that stores the
live demo state/log, and a downloadable standalone `trpc-cli` client:

```text
.../playground/itx-egress-cli.mts
```

### 5-minute demo

1. Open the playground URL.
2. Copy the **Run the interactive ITX egress CLI** command into a terminal. It
   makes a temp dir, installs pinned `tsx`, `trpc-cli`, `@orpc/server`, `zod`,
   `capnweb`, and `ws`, downloads `itx-egress-cli.mts`, and prompts for a mode.
3. Choose `plain-intercept-listen`, then click **Fetch Postman GET/POST** on the
   page. The Node process prints the full request URL, method, headers, and body
   — an interceptor runs _before_ secret substitution, so it sees placeholders.
4. Restart the CLI, choose `blind-relay-listen`, then click **any** fetch button
   — a plain Postman fetch or a secret-bearing one. The Node process now prints
   only encrypted connection metadata for each: host, SNI, remote IP, first TLS
   bytes, byte counts. The plaintext is gone, and for secret requests the
   substituted secret never reaches the relay either.
5. Watch **Live relay demo state** on the page; it polls the Durable Object once
   per second for status and observations.

### Shared demo inputs

Browser scripts and the CLI default to the same project and demo secret:

```text
projectId / slug: playground-demo-default
secret: /secrets/playground/api-token = demo-secret-material
```

### CLI modes

- `plain-intercept-listen` / `blind-relay-listen` — stay attached to the shared
  project until Ctrl+C. Both see **every** page-triggered request: the plain
  interceptor logs plaintext (it runs before secret substitution); the blind
  relay logs encrypted connection metadata only.
- `plain-intercept` / `blind-relay` — run one CLI-generated request end to end.
- `blind-relay-proof` — the blind relay path plus an assertion that the relay
  transcript contains none of the secret, body, path, or query-token plaintext.

For a self-contained one-liner:

```bash
tmp="$(mktemp -d)" && cd "$tmp" && npm init -y >/dev/null && npm install tsx@4.21.0 trpc-cli@0.15.1 @orpc/server@1.14.6 zod@4.4.3 capnweb@0.8.0 ws@8.19.0 >/dev/null && curl -fsS https://minimal-itx-v4-blind-relay-poc.iterate-dev-preview.workers.dev/playground/itx-egress-cli.mts -o itx-egress-cli.mts && npx tsx itx-egress-cli.mts run --base-url https://minimal-itx-v4-blind-relay-poc.iterate-dev-preview.workers.dev --demo-id default --body "payload hidden from relay" --secret-material "blind-secret-material"
```

Expected result: the HTTPS target receives `Bearer blind-secret-material` from
the relay machine's IP, the relay observation records TLS bytes starting with
`0x16`, the transcript holds no plaintext, and the secret's usage audit
increments. This is intentionally narrow — the worker terminates TLS; the relay
only dials TCP and shuttles encrypted records.

The original Vitest proof remains a repo regression test:

```bash
ITX_BASE_URL=https://minimal-itx-v4-blind-relay-poc.iterate-dev-preview.workers.dev pnpm --dir apps/minimal-itx-v4 exec vitest run itx.e2e.test.ts -t "Project egress relays secret-backed HTTPS"
```

---

## Page debugging

The worker routes `/page-debugging/*` to `PageDebuggingDemoDurableObject`, which
hosts the demo page, mints short-lived HMAC tokens (claims stored in its own
storage), and serves a tiny browser ESM client.

Open the demo:

```text
http://127.0.0.1:8791/page-debugging
https://minimal-itx-v4.iterate-dev-preview.workers.dev/page-debugging
```

### Live demo flow

1. Open the demo page and copy the generated snippet.
2. Paste it into any target page's DevTools console (the host page, not a
   cross-origin iframe, if you want host-page screenshots). The snippet imports
   only the worker-hosted client module:

   ```js
   const { connectPageTools } = await import("http://127.0.0.1:8791/page-debugging/client.mjs");
   ```

3. The target page gets an **ITERATE** widget bottom-right with **Share a
   screenshot**, **Enable screen capture**, **Copy page URL**, and **Stop
   sharing** (which revokes that session's tokens).
4. Back on the demo page, click **Take Screenshot**, **Snapshot**, **Click
   counter**, or **Fill message**. Each call crosses the worker and invokes the
   mounted `debugPage` capability in the target tab.
5. For a no-DevTools demo, click **Run in this tab** to mount the same capability
   on the demo page itself.

### How the capability is provided

The client module imports `capnweb`, Testing Library DOM queries, and
`user-event` from esm.sh, then mounts a `PageTools` `RpcTarget` and hands it to
the worker. Because browsers can't set `Authorization` on WebSocket upgrades,
the auth token rides in `Sec-WebSocket-Protocol` as `itx-page-debugging.<token>`;
the server verifies the HMAC and checks the token id still exists in storage
before vending project ITX. `screenshot()` falls back to a host-DOM render by
default and uses the Screen Capture API once the user enables host capture.

Each generated session gets a throwaway project id and split provider/agent
tokens, so concurrent demos never fight over the same mounted capability.

Browser proof:

```bash
ITX_BASE_URL=http://localhost:8791 pnpm --dir apps/minimal-itx-v4 exec vitest run page-debugging-demo.e2e.test.ts
```
