---
state: done
priority: medium
size: small
dependsOn: []
tags: [streams-example-app, itx, iterate-package, consolidation]
---

# streams-example-app: drop the hand-rolled dial for the shared itx client

**Resolved 2026-07-17 — mostly a false positive; the real slice shipped.**

On contact with the code, the "hand-rolled dial" turned out to be deliberate
playground scaffolding, not a duplicate of the shared client: the app never
speaks the OS `/api` session surface. Its worker serves its OWN bare capnweb
endpoint (`/api/streams`) exposing `PlaygroundStream` — the public `Stream`
contract plus playground-only `kill`/`reset` operator verbs — and its
connection modules exist to demo exactly that: a raw per-stream socket with a
wire-frame inspector tapping in/out frames. No `authenticate()`, no Session,
no credentials — so the `iterate/client` keeper (whose whole job is the
authenticated one-session socket) is the wrong shape here BY DESIGN, and the
~10-line dial-and-wrap is the demonstration, not debt.

What WAS genuinely shared-pattern shipped in the resolving PR: the app's five
`~/itx-api.generated.ts` cross-app type imports now come from `iterate/sdk`
(type-only, erased at build). The `~` alias into `apps/os/src` remains ONLY
for the browser-mirror machinery (`domains/streams/client-libraries/…`),
which is gated on `tasks/stream-mirror-collapse-vs-move.md`.
