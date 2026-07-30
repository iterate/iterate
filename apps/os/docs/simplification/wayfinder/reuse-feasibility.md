# Reuse feasibility: importing apps/os DOs into the clean-room kernel

Load-bearing finding (2026-07-30, code trace) that gates the lab build plan. Jonas's condition for
"DOs first" was: _only if we can reuse/import the existing code without modification._ Answer below.

## Verdict: the DO **classes** cannot be imported unmodified

- **`StreamDurableObject`** (`domains/streams/stream-durable-object.ts`) — welded to the full os `Env`
  and to `rpc-targets.ts` via `itxForScope()`/`deploymentItxForInternal`/`StreamSubscriptionRpcTarget`
  (`:306`, `:1300`). `rpc-targets.ts` = **7,667 LOC / 87 first-hop imports** spanning every domain.
  Importing the class drags in ~all of apps/os. **Not feasible without surgery.**
- **`RepoDurableObject`** (`domains/repos/repo-durable-object.ts`) — imports `rpc-targets.ts` at the
  **top of the class file** (`:8-9`), needs `ARTIFACTS` + `FILES_BUCKET` bindings the kernel lacks, and
  `@cloudflare/shell`/`@cloudflare/shell/git` (a full git-in-workerd impl) the kernel doesn't depend on.
  **Not feasible without surgery; no clean lower seam.**

## The clean seam that IS importable verbatim (streams only)

The append/reduce/SQLite-log **engine** is cleanly factored — **zero `Env`/itx/rpc-targets coupling**,
~1,750 LOC, importable unmodified:

- `domains/streams/stream-storage.ts` (675 LOC — `StreamEventLog`, `SqliteSubscriptionCursorStore`;
  imports only `sqlfu` + `iterate/processors`)
- `domains/streams/core-processor-contract.ts` (525 LOC — `zod`, `itx/expression.ts`, `event-selector`)
- `domains/streams/event-selector.ts` (94 LOC), `cross-post.ts` (154), `durable-object-names.ts` (183,
  zero non-type imports), `stream-unavailable.ts` (117, zero non-type imports)

**So the entanglement is purely at the itx-delivery surface** — exactly what "break up rpc-targets"
targets. The storage engine already stands free of the monolith. Good sign for the migration.

## Consequence for the build plan

- **Stream DO first, as "reuse the engine verbatim + a thin fresh kernel wrapper".** Real reuse of the
  load-bearing 1,750 LOC; the wrapper wires delivery/subscription against the kernel's own `Env`. The
  lab thereby _demonstrates the decoupled shape_ we're aiming for.
- **Drop the repo DO from the first step** — no clean seam; it'd be fresh work (possibly reusing
  `@cloudflare/shell` git primitives directly, not `repo-durable-object.ts`).
- Open: does "reuse the engine, write a thin wrapper" meet Jonas's bar, or does the class-level
  entanglement mean we should prove the capnweb reach path first and defer DOs?
