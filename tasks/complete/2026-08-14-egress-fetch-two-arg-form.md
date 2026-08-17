---
status: implemented
size: small
---

# Support the standard two-arg `fetch(url, init)` form on egress fetch handles

**Status summary:** Implemented and unit-suite green. Both user-callable
fetch handles accept `(input, init?)`, docs/examples/generated contract
regenerated, and a new e2e proves method+headers+body reach the upstream on
both handles (runs on the PR's preview deploy). Nothing known missing.

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

- [x] `ProjectEgressRpcTarget.fetch` accepts the standard signature `fetch(input: RequestInfo | URL, init?: RequestInit)`, building `new Request(input, init)` server-side — _rpc-targets.ts, `new Request(input, init)` wrapped in the existing `withStreamContext`_
- [x] `SecretRpcTarget.fetch` (the other user-callable fetch-shaped handle, backed by the Secret DO) gets the same treatment — _same construction before `durableObjectStub.fetch`_
- [x] `__describe()` instruction strings updated to advertise `fetch(input, init?)` — _both targets_
- [x] `egress-fetch` catalogue example (`apps/os/src/itx/examples-source.ts`) rewritten to show the two-arg form; regenerate `examples.generated.ts` (`pnpm generate:itx-examples` or equivalent) — _example now leads with the two-arg form_
- [x] Regenerate the public contract `itx-api.generated.ts` via `pnpm generate:itx-api` (do not hand-edit) — _both apps/os and packages/iterate copies, plus itx-api-graph_
- [x] e2e test in `apps/os/e2e/vitest/itx-egress.e2e.test.ts` proving the two-arg form's method, headers, and body reach the upstream (for both `project.egress.fetch` and the secret handle's `fetch`) — _"two-arg fetch(url, init) carries method, headers, and body to the upstream"; secret lane also asserts placeholder substitution in init headers_
- [x] Full pre-PR gauntlet green: install, typecheck, lint, knip, format, test — _all green locally; e2e runs on the PR preview_

## Non-goals

- Internal platform-only fetch paths (e.g. `ProjectEgressEntrypoint` used as
  workerd `globalOutbound`) — workerd always hands those a real `Request`.
- `ProjectAuthRpcTarget.fetch` — it deliberately remains a one-argument
  `Request` method; `IterateWorkerEntrypoint.fetchProjectAuth()` preserves an
  app request body by sending a fresh bodyless request on paths auth may
  decline.
- The browser binding target already accepts `(input, init)` — no change.

## Notes

- When `input` is already a `Request` and `init` is undefined,
  `new Request(input)` preserves everything in workerd (the existing
  `withStreamContext` already reconstructs body-bearing requests with
  `new Request(request, { headers })`, exercised by the JSON-template e2e).
- The riskiest part is Request reconstruction semantics for body-bearing
  requests across the RPC boundary — covered by the new e2e's POST body
  assertion.
