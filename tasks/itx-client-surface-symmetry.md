---
state: todo
priority: low
size: small
dependsOn: []
tags: [itx, iterate-package, api-polish, dx]
---

# itx client surface polish (post-#2063)

Rewritten 2026-07-17: most of this task's original content shipped — PR #2048
unified the browser surface (one socket, `useItx(slug?)`/`connectItx(slug)`)
and PR #2063 moved everything into `packages/iterate` with the shared core
factored once (`apiWebSocketUrl`, one keeper, `iterate/client` vs
`iterate/node` keeping the `ws` import out of browser bundles). What remains
is a small polish list collected from #2063's reviews:

- **`connectItx` means two things across sibling entries**: `iterate/client`'s
  keeper slug-dial (`connectItx(slug): Promise<ProjectStub>`) vs
  `iterate/node`'s one-shot object-dial (`connectItx(input)` overloads).
  Signatures make misuse a type error, but it is now public npm surface —
  rename one (e.g. node's → `dialItx`) if/when the node entry is touched.
- **`closeIterateSession()`**: the keeper has no shutdown; every keeper-based
  script must `process.exit` (documented in `client.ts`'s header). Additive:
  retire the current generation without redial; define semantics for pending
  awaiters/firstConnect.
- **`disposeStub(stub)` helper** to absorb the repeated
  `(x as Partial<Disposable>)[Symbol.dispose]?.()` casts (six sites) so the
  "capnweb stubs are loosely-typed disposables" acknowledgment lives once.
- **`serverSnapshot`** is a React-flavored name exported from the
  framework-free module — cosmetic rename candidate.
- **`lostConnectionTimeout`-style UX signal** (the one idea worth stealing
  from the Liveblocks survey): a fast "connection is struggling" status,
  distinct from the reconnect machinery, so UIs can show degraded state
  before the two-strike verifier settles.
- **Singleton → instance evolution note** (roadmap, not committed): the field
  pattern is a client instance behind a Provider or a `createHooks(client)`
  factory with a lazy default singleton. Revisit only if a real need appears
  (tests wanting isolation, multi-deployment tabs).

Pointers: `packages/iterate/src/itx/itx-session.ts`, `itx-react.ts`,
`itx-node-client.ts`; #2063's fable/thermo review findings.
