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

In both cases the shape is identical: `project.egress.useTunnelingProxy(relay)`
and `connectPageTools(...)` each hand the project a `RpcTarget` that outlives the
call, and the project invokes it later. That symmetry is the point — ITX lets an
untrusted-to-the-worker client lend a narrow, live capability without the worker
having to trust the client with the payload, and without the client having to
trust the worker with its socket or its page.

Both demos live entirely in `apps/minimal-itx-v4`, each behind its own Durable
Object and route, so they can be deployed and torn down independently.

---

## Blind relay egress

The worker's home page (`/`) links to both demos. The blind relay playground is at:

```text
https://minimal-itx-v4-blind-relay-poc.iterate-dev-preview.workers.dev/playground
```

Open it, pick an ITX script button, read (or edit) the `async (itx) => { ... }`
function in the textarea, and click **Run**. The script runs server-side inside
the shared demo project. The page also hosts a small Durable Object that stores
the live demo state/log, and a downloadable standalone `trpc-cli` listener:

```text
.../playground/itx-egress-cli.mts
```

### 5-minute demo

1. Open the playground URL.
2. Copy the **Run a local egress listener** command into a terminal. It makes a
   temp dir, installs pinned deps, downloads `itx-egress-cli.mts`, and asks you
   to pick a mode.
3. Pick `plain`, then click **any** fetch button on the page. The Node process
   prints the full request (URL, method, headers, body). A plain interceptor
   runs _before_ secret substitution, so it sees `getSecret(...)` placeholders.
4. Restart the CLI, pick `blind`, then click **any** fetch button — plain or
   secret-bearing. Now the Node process prints only encrypted connection
   metadata: host, SNI, remote IP, first TLS bytes, byte counts. The plaintext
   is gone, and for secret requests the substituted secret never reaches the
   relay either.
5. Watch **Live relay demo state** on the page; it polls the Durable Object once
   per second for status and observations.

### Shared demo inputs

Browser scripts and the CLI default to the same project and demo secret:

```text
projectId / slug: playground-demo-default
secret: /secrets/playground/api-token = demo-secret-material
```

### CLI modes

There are just two, and both stay attached to the shared project until Ctrl+C,
logging **every** request you trigger from the page:

- `plain` — installs an egress interceptor and prints the full request (URL,
  method, headers, body). Runs before secret substitution.
- `blind` — installs a blind relay and prints only encrypted TLS metadata
  (host, SNI, remote IP, byte counts). The worker substitutes secrets and
  terminates TLS itself, so the relay never sees plaintext.

For a self-contained one-liner:

```bash
tmp="$(mktemp -d)" && cd "$tmp" && npm init -y >/dev/null && npm install tsx@4.21.0 trpc-cli@0.15.1 @orpc/server@1.14.6 zod@4.4.3 capnweb@0.8.0 ws@8.19.0 >/dev/null && curl -fsS https://minimal-itx-v4-blind-relay-poc.iterate-dev-preview.workers.dev/playground/itx-egress-cli.mts -o itx-egress-cli.mts && npx tsx itx-egress-cli.mts listen --base-url https://minimal-itx-v4-blind-relay-poc.iterate-dev-preview.workers.dev --demo-id default
```

With `blind`, a secret-bearing request reaches the HTTPS target as
`Bearer demo-secret-material` from the relay machine's IP, the relay observation
records TLS bytes starting with `0x16`, and its transcript holds no plaintext.
This is intentionally narrow — the worker terminates TLS; the relay only dials
TCP and shuttles encrypted records.

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
2. Paste it into any target page's DevTools console. The snippet is
   **dependency-free** — no imports, no external `<script>`, no socket.
3. The target page gets an **ITERATE** widget bottom-right with **Share a
   screenshot**, **Copy page URL**, and **Stop sharing** (which revokes that
   session's tokens).
4. Back on the demo page, run a script — **Snapshot**, **Take a screenshot**,
   **Click the counter button**, **Fill the message field**. Each shows the
   exact code, crosses the worker, and invokes the mounted `debugPage`
   capability in the target tab.
5. For a no-DevTools demo, click **Run in this tab** to mount the same capability
   on the demo page itself.

### How the capability is provided (and why it survives strict CSP)

The snippet can't load capnweb or open a WebSocket from the host page — a strict
host CSP (`script-src`/`connect-src 'self'`) forbids both. So everything
networked lives in a **worker-origin iframe** the snippet embeds
(`/page-debugging/bridge`), which runs under the worker's own permissive CSP: it
loads `capnweb`, opens the capability socket, and mounts a `PageTools`
`RpcTarget`. Because browsers can't set `Authorization` on WebSocket upgrades,
the token rides in `Sec-WebSocket-Protocol` as `itx-page-debugging.<token>`; the
server verifies the HMAC and checks the token id still exists in storage before
vending project ITX.

Every `PageTools` method forwards the actual DOM work to the host page over
`postMessage`, where the dependency-free snippet runs it with plain DOM APIs
(role/label/text/testid/css queries, click/fill/read, snapshot). Screenshots use
an SVG-render fallback by default; if the user clicks **Enable screen capture**
in the widget (which supplies the required user gesture for `getDisplayMedia`),
they switch to real host-tab pixels. The one hard limit: no pasted snippet can
escape a total
`default-src 'self'` — the host must allow the worker origin in `frame-src`
(the common strict case that locks down script/connect but permits framing).

Each generated session gets a throwaway project id and split provider/agent
tokens, so concurrent demos never fight over the same mounted capability.

Browser proof:

```bash
ITX_BASE_URL=http://localhost:8791 pnpm --dir apps/minimal-itx-v4 exec vitest run page-debugging-demo.e2e.test.ts
```
