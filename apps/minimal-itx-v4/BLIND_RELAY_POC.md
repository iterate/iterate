# Blind Relay POC

This branch deploys a separate demo Worker so it does not compete with the
normal `minimal-itx-v4` deployment:

```text
https://minimal-itx-v4-blind-relay-poc.iterate-dev-preview.workers.dev/playground
```

Open the playground, pick a preset, edit the JSON command, and click **Run**.
The commands run server-side against the ITX surface with trusted-internal
authority on this dev Worker.

## 5-minute demo

1. Open the playground URL above.
2. Run **Secret Egress**. Point at the summary: the hosted target receives
   `authorization: Bearer demo-secret-material`, proving normal secret
   substitution still works.
3. Run **Plain Intercept Placeholder**. Point at the summary: a normal
   interceptor sees `getSecret({ path: ... })`, not the materialized secret, and
   the secret audit count stays at zero.
4. Run **Blind Relay Proof Command** and copy the printed command into a
   terminal from the repo root. That command runs the local TCP relay harness
   against the deployed Worker and proves the relay transcript contains TLS
   records, not plaintext secret/body/path/query data.

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
- **Blind Relay Proof Command** prints the command that runs the local relay
  harness against the deployed Worker.

## Blind Relay Proof

The browser page can prove normal egress and secret substitution, but it cannot
own the raw TCP socket needed by the relay side. Run the Vitest proof from the
repo root instead:

Prerequisites:

- `pnpm install`
- `openssl` on `PATH` for the test-only self-signed HTTPS target
- run from the repo root

```bash
ITX_BASE_URL=https://minimal-itx-v4-blind-relay-poc.iterate-dev-preview.workers.dev pnpm --dir apps/minimal-itx-v4 exec vitest run itx.e2e.test.ts -t "Project egress relays secret-backed HTTPS"
```

Expected result:

- the HTTPS target receives `Bearer blind-secret-material`
- the relay observation records TLS bytes beginning with `0x16`
- the full worker-to-target relay transcript does not contain the secret, body,
  path, or query token plaintext
- the secret usage audit increments after the request

This is intentionally a narrow POC: the Worker materializes secrets and runs TLS
locally, while the relay only dials TCP and moves encrypted records.
