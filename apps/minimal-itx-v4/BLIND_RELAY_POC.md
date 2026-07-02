# Blind Relay POC

This branch deploys a separate demo Worker so it does not compete with the
normal `minimal-itx-v4` deployment:

```text
https://minimal-itx-v4-blind-relay-poc.iterate-dev-preview.workers.dev/playground
```

Open the playground, pick a preset, edit the JSON command, and click **Run**.
The commands run server-side against the ITX surface with trusted-internal
authority on this dev Worker.

The playground also hosts the browser UI, a small Durable Object that stores the
current demo state/log, and a downloadable standalone TypeScript relay client:

```text
https://minimal-itx-v4-blind-relay-poc.iterate-dev-preview.workers.dev/playground/blind-relay-proof.ts
```

## 5-minute demo

1. Open the playground URL above.
2. Copy **Run the local Node relay** into a terminal. It creates a temp
   directory, installs pinned copies of `tsx`, `capnweb`, and `ws`, downloads
   `blind-relay-proof.ts`, and runs the local TCP relay against the deployed
   Worker.
3. Watch **Live relay demo state** on the page. It polls the Durable Object once
   per second and should end at `relay_saw_ciphertext_only`, with the target IP,
   relay byte counts, and request log.
4. Optional warmup: run **Secret Egress**. Point at the summary: the hosted target receives
   `authorization: Bearer demo-secret-material`, proving normal secret
   substitution still works.
5. Optional warmup: run **Plain Intercept Placeholder**. Point at the summary: a normal
   interceptor sees `getSecret({ path: ... })`, not the materialized secret, and
   the secret audit count stays at zero.

## Presets

- **Project Egress** creates a throwaway project and sends a normal egress
  request to `/playground/target`.
- **Plain Intercept Placeholder** installs a normal egress interceptor. It sees
  the request before secret substitution, so the response includes an
  `authorization` header containing `getSecret({ path: ... })`, not the secret
  material. The secret audit count remains zero.
- **Secret Egress** creates a secret, sends an egress request with a
  `getSecret(...)` placeholder, and shows the hosted target receiving the
  substituted header, for example `authorization: Bearer demo-secret-material`.
- **Blind Relay Proof Command** prints the same one-liner shown at the top of
  the page.

## Blind Relay Proof

The browser page can prove normal egress and secret substitution, but it cannot
own the raw TCP socket needed by the relay side. The hosted one-liner runs that
piece from your machine:

```bash
tmp="$(mktemp -d)" && cd "$tmp" && npm init -y >/dev/null && npm install tsx@4.21.0 capnweb@0.8.0 ws@8.19.0 >/dev/null && curl -fsS https://minimal-itx-v4-blind-relay-poc.iterate-dev-preview.workers.dev/playground/blind-relay-proof.ts -o blind-relay-proof.ts && npx tsx blind-relay-proof.ts https://minimal-itx-v4-blind-relay-poc.iterate-dev-preview.workers.dev default
```

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
