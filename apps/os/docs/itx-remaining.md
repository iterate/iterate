# itx: everything that remains

Single-file goal sheet, written 2026-06-11. Each item carries its
done-condition and the doc that specifies it. Design docs of record:
`itx-next.md` (the shipped unification + final statement),
`itx-later.md` (horizon designs, several LOCKED), `itx-authority-research.md`
(the authority verdict), `docs/domain-objects-and-stream-processors.md`
(doctrine), `tasks/stream-processors-as-facets.md`.

## A. In flight (PR #1493, must land)

1. ~~Repo-sourced workers wave~~ DONE (2026-06-11): `WorkerSource =
inline | repo`, R2 build memo (`ITX_BUILD_CACHE`), worker-bundler on
   the repo DO's `readTree` (one checkout: head oid + files), `worker`
   default an ordinary repo provide, ProjectWorker/WorkerHost deleted.
   Litmus green on preview: a repo-sourced, bundler-built capability
   through the generic source dial.
2. **Land the PR**: every wave so far is CI-green; merge after the
   final cycle.
3. **Production proof across ALL runtimes**: after prd deploy, run the
   full e2e suite set + the example matrix (browser/node/cli runtimes)
   against os.iterate.com; include the middleware + indirection
   acceptance tests and a repo-sourced bundler-built capability dialed
   live in prd.

Known environment issue (recorded, not blocking): the itx e2e suite
fails against LOCAL vite dev only — capnweb-fork RpcTarget identity
under the dev module graph hides handle methods over RPC; deployed
environments are unaffected. Verify suspicious local failures against
a preview slot before treating them as regressions.

## B. Punch list — DONE (2026-06-11, all on the PR)

4. ~~`ctx_` → `itx_`~~ · 5. ~~`connectItx` → `withItx`~~ ·
5. ~~`{ revoke }`-only provide returns~~ (the core returns void; the
   handle's `CapabilityProvision` is the one provision object) ·
6. ~~`parent` → `super`~~ (the journal's `parent` payload field stays —
   that is data) · 8. ~~repo identity → `/repos/project`~~ ·
7. ~~README use-case-first rewrite~~ (three scenes + appendix).
   Also landed: the oRPC capability surface (`OrpcCapability`/itx.os)
   deleted; the adversarial review applied — unreachable surfaces
   deleted (OpenApiBridge, AiCapability, url-dial path-call), types.ts
   is the IMPORTED record (drift is now a type error), catch-up
   observes its own appends, typed missing-worker errors, memo key
   carries compatibilityDate, vocabulary converged (extend, the dial,
   no sessions).

## C. Designed and specced, not yet built (each its own PR)

10. **Derived URLs + HTTP routes v1** (itx-later.md §HTTP):
    `{door}--{slug}.iterate.app` + self-parsing paths (reserved `itx`
    segment splits context coordinate from capability path);
    `urlFor()`; routes as provides under reserved `http` subtree,
    EXACT-HOST only; root hostname → `worker` capability becomes an
    ordinary shadowable platform-default route; edge validates host
    ownership on the `http` subtree. Candidate flagged: every derived
    URL serves capnweb by default (connect-to-the-capability); plain
    HTTP only for fetch-implementing capabilities.
11. **Authority seam** (itx-authority-research.md): principal-compiled
    path MASK on the handle at the connect edge (allow-all until
    tokens can express per-project roles), principal injected as dial
    attribution for first-party resource policy + journal actor
    records. GuardCapability and narrow({scopes}) are DELETED from the
    design. Contexts stay principal-free.
12. **Retention** (deferred by owner, design exists): dispose-deletes,
    idle-TTL alarms for anonymous contexts, ownership cascade.
    Narrowed/derived URLs expire with their contexts for free.
13. **Manifest + durable Workers** (itx-later.md §Workers LOCKED):
    `iterate.toml` at repo root declares worker names (+ stable
    durable-object facet names); workers are ephemeral OR durable —
    durable = repo-associated, journaled in the REPO's stream
    (worker-created/built/route events folded by the repo processor),
    repo DO as the runner; lazy materialization on first reference.
14. **Stream processors as facets**
    (tasks/stream-processors-as-facets.md): ProcessorFacet with private
    SQLite kills shared-storage checkpoint wiring; per-host composition
    subclasses; converge with/replace StreamProcessorRunner. After the
    facets API is exercised by itx.
15. **Global as a code-rooted context** (finisher noted it open):
    platform:global with `projects` etc. as its provides; global
    handles get describe/fallthrough like everyone else.

## D. Standing doctrine (applies to all of the above)

- Creation is an event; the journal begins with its own birth
  certificate. No initialize RPCs, no idempotency keys as correctness.
- Everything writable is durable; the root of every chain is code.
- Identity is a stream coordinate; names are declared or minted, never
  derived from code locations; addresses/URLs/journal refs are parses
  of the name.
- One verb, one calling convention, one map, longest-prefix dispatch.
- Self-describing, always: agents' only sense organ is describe();
  every fold doubles as a description; instructions + types at provide
  time; "what does describe() say about this?" gates every feature.
- The core stays one readable file (`itx.ts`, currently 529 code
  lines); anything that grows it past ~550 belongs in a sibling.
