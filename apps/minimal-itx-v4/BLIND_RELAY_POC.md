# Blind Relay POC

This branch deploys a separate demo Worker so it does not compete with the
normal `minimal-itx-v4` deployment:

```text
https://minimal-itx-v4-blind-relay-poc.iterate-dev-preview.workers.dev/playground
```

Open the playground, pick an ITX script button, inspect the async function in the
textarea, edit it if you want, and click **Run**. The edited script runs
server-side inside the shared demo project on this dev Worker.

The playground also hosts the browser UI, a small Durable Object that stores the
current demo state/log, and a downloadable standalone TypeScript `trpc-cli`
client backed by an oRPC router:

```text
https://minimal-itx-v4-blind-relay-poc.iterate-dev-preview.workers.dev/playground/itx-egress-cli.mts
```

## 5-minute demo

1. Open the playground URL above.
2. Copy **Run the interactive ITX egress CLI** into a terminal. It creates a
   temp directory, installs pinned copies of `tsx`, `trpc-cli`, `@orpc/server`,
   `zod`, `capnweb`, and `ws`, downloads `itx-egress-cli.mts`, and prompts for
   a mode.
3. Choose `plain-intercept-listen` in the CLI, then click **Fetch Postman GET**
   or **Fetch Postman POST** on the page. The local Node process prints full
   request URL, method, headers, and body.
4. Restart the CLI and choose `blind-relay-listen`, then click a secret-bearing
   script such as **Fetch Headers With Secret**. The local Node process prints
   encrypted connection metadata: requested host, SNI when available, remote IP,
   TLS byte previews, and byte counts.
5. Watch **Live relay demo state** on the page. It polls the Durable Object once
   per second for listener/proof status and request observations.

## Shared Demo Inputs

The browser scripts and the local CLI use the same shared project by default:

```text
projectId: playground-demo-default
slug: playground-demo-default
```

The page guarantees this demo secret before secret-bearing requests:

```text
/secrets/playground/api-token = demo-secret-material
```

## ITX Scripts

The left-side buttons load actual async ITX functions into the textarea. The Run
button sends the edited JavaScript to the Worker and evaluates it as
`async function run(itx, helpers)`, where `itx` is the shared demo project root.

- **Fetch Postman GET** sends a normal `itx.egress.fetch(...)` GET to
  `https://postman-echo.com/get?source=itx-playground`.
- **Fetch Postman POST** sends a normal JSON POST to
  `https://postman-echo.com/post`.
- **Fetch Headers With Secret** sends `authorization:
Bearer getSecret({ path: "/secrets/playground/api-token" })` to
  `https://postman-echo.com/headers`, which echoes the substituted
  `Bearer demo-secret-material` header.
- **POST With Secret** sends a secret-bearing POST to Postman Echo.
- **Hosted Target With Secret** sends a secret-bearing POST to this Worker’s
  `/playground/target?demo=default`, so the page can correlate target events.
- **Interactive Egress CLI Command** prints the same one-liner shown at the top
  of the page.

## Blind Relay Proof

The browser page can prove normal egress and secret substitution, but it cannot
own the raw TCP socket needed by the relay side. The hosted one-liner runs an
interactive `trpc-cli` script backed by an oRPC router from your machine:

```bash
tmp="$(mktemp -d)" && cd "$tmp" && npm init -y >/dev/null && npm install tsx@4.21.0 trpc-cli@0.15.1 @orpc/server@1.14.6 zod@4.4.3 capnweb@0.8.0 ws@8.19.0 >/dev/null && curl -fsS https://minimal-itx-v4-blind-relay-poc.iterate-dev-preview.workers.dev/playground/itx-egress-cli.mts -o itx-egress-cli.mts && npx tsx itx-egress-cli.mts run --base-url https://minimal-itx-v4-blind-relay-poc.iterate-dev-preview.workers.dev --demo-id default --body "payload hidden from relay" --secret-material "blind-secret-material"
```

CLI modes:

- `plain-intercept-listen` installs a normal egress interceptor on the shared
  demo project and stays attached until Ctrl+C. Each page-triggered request is
  printed with URL, method, headers, and body.
- `blind-relay-listen` installs a local TCP relay on the shared demo project and
  stays attached until Ctrl+C. Secret-bearing page-triggered requests are
  printed as encrypted connection metadata only: host, SNI, remote IP, first TLS
  bytes, and byte counts.
- `plain-intercept` installs a normal egress interceptor and shows the
  unencrypted request body/header placeholder for one CLI-generated request.
- `blind-relay` installs a local TCP relay and shows the target receiving the
  materialized secret from the Node process's egress IP while the relay sees TLS
  bytes.
- `blind-relay-proof` runs the same blind relay path and also fails if the relay
  transcript contains the secret, body, path, or query token plaintext.

Expected result:

- the HTTPS target receives `Bearer blind-secret-material`
- Cloudflare reports the target request as coming from the machine running the
  Node relay
- the relay observation records TLS bytes beginning with `0x16`
- the full worker-to-target relay transcript does not contain the secret, body,
  path, or query token plaintext
- the secret usage audit increments after the request

This is intentionally a narrow POC: the Worker materializes secrets and runs TLS
locally, while the relay only dials TCP and moves encrypted records.

To verify the IP claim, compare `targetClientIp` in the CLI output or page
summary with the public IP of the machine running the Node command.

The original Vitest proof is still useful as a repo regression test:

```bash
ITX_BASE_URL=https://minimal-itx-v4-blind-relay-poc.iterate-dev-preview.workers.dev pnpm --dir apps/minimal-itx-v4 exec vitest run itx.e2e.test.ts -t "Project egress relays secret-backed HTTPS"
```
