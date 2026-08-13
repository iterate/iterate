---
status: ready
size: small
---

# Support the standard two-arg `fetch(url, init)` form on egress fetch handles

`itx.egress.fetch(url, init)` silently DROPS the `init` argument — headers,
method, and body are all lost. Verified against prod today:

```ts
// headers silently dropped — httpbin saw NO custom headers:
await itx.egress.fetch("https://httpbin.org/headers", {
  headers: { "User-Agent": "iterate-header-probe/1.0", "X-Probe": "hello" },
});

// headers arrive fine only via the one-arg Request form:
await itx.egress.fetch(new Request("https://httpbin.org/headers", { headers: { "X-Probe": "hello" } }));
```

Root cause: `ProjectEgressRpcTarget.fetch(request: Request)` in
`apps/os/src/rpc-targets.ts` takes a single parameter, so the second argument
vanishes at the RPC boundary. The two-arg browser-style form is every
agent's muscle memory — a prod agent session today repeatedly told the user it
sent an Authorization header when the egress lane had dropped it. Worse, our
own config repo template (`config-repo-template.generated.ts`) *teaches* the
two-arg form (`itx.egress.fetch("https://api.acme.com/v1/me", {...})`), and the
egress-fetch catalogue example documents the trap ("a second fetch-style init
is ignored") instead of fixing it.

## Checklist

- [ ] `ProjectEgressRpcTarget.fetch` accepts the standard signature `fetch(input: RequestInfo | URL, init?: RequestInit)`, building `new Request(input, init)` server-side
- [ ] `SecretRpcTarget.fetch` (the other user-callable fetch-shaped handle, backed by the Secret DO) gets the same treatment
- [ ] `__describe()` instruction strings updated to advertise `fetch(input, init?)`
- [ ] `egress-fetch` catalogue example (`apps/os/src/itx/examples-source.ts`) rewritten to show the two-arg form; regenerate `examples.generated.ts` (`pnpm generate:itx-examples` or equivalent)
- [ ] Regenerate the public contract `itx-api.generated.ts` via `pnpm generate:itx-api` (do not hand-edit)
- [ ] e2e test in `apps/os/e2e/vitest/itx-egress.e2e.test.ts` proving the two-arg form's method, headers, and body reach the upstream (for both `project.egress.fetch` and the secret handle's `fetch`)
- [ ] Full pre-PR gauntlet green: install, typecheck, lint, knip, format, test

## Non-goals

- Internal platform-only fetch paths (e.g. `ProjectEgressEntrypoint` used as
  workerd `globalOutbound`) — workerd always hands those a real `Request`.
- `ProjectAuthPolicyRpcTarget.fetch` — it already has a deliberate
  `ProjectAuthRpcMetadata | Request` union signature for the app-RPC lane.
- The browser binding target already accepts `(input, init)` — no change.

## Notes

- When `input` is already a `Request` and `init` is undefined,
  `new Request(input)` preserves everything in workerd (the existing
  `withStreamContext` already reconstructs body-bearing requests with
  `new Request(request, { headers })`, exercised by the JSON-template e2e).
- The riskiest part is Request reconstruction semantics for body-bearing
  requests across the RPC boundary — covered by the new e2e's POST body
  assertion.
