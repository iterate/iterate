# First small steps toward killing oRPC

Context: `itx-everywhere-plan.md` (the full cutover plan and its decisions).
Codemode deletion is happening separately (`itx-step1-kill-codemode-plan.md`,
owned by another agent) — nothing below depends on it or touches it.

Four steps, each an independently shippable small PR. A and B have no
dependencies at all; C needs B; D needs B plus one kernel addition. Together
they retire the first oRPC procedures, produce the client library, and convert
the first two views to the new style — without blocking on the big cutover.

## Step A — delete the dead surface (~1 hour, pure deletion)

Verified by grep (not the earlier estimate of "16 unused" — most of those had
e2e consumers; the real list is smaller):

| Delete                                                                                                | Why                                                                                                                      |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `project.streams.getState` (contract + `orpc/routers/streams.ts:88`)                                  | zero consumers anywhere (one hit in `scripts/event-stream-terminal.tsx` — fix or delete the script)                      |
| `ping`, `test.logDemo`, `test.serverThrow`, `test.randomLogStream` + the whole `orpc/routers/test.ts` | demo-only                                                                                                                |
| `routes/_app/debug.tsx`, `routes/_app/log-stream.tsx`                                                 | the only consumers of the above; log-stream was the oRPC-streaming demo and its replacement is Step D's live stream view |

Also riding along separately: `project.codemode.*` (6 procedures) die with the
codemode work. After A + codemode, the contract is down from 46 to ~35
procedures, all with real consumers.

## Step B — the client library: `apps/os/src/itx/react/` (~300 LOC + tests)

The piece we'd "come up with" before converting anything. Needs **zero kernel
changes** — browser session-cookie auth at `/api/itx` already works
(fetch.ts:129), capnweb already runs in the browser (the REPL proves it).

```tsx
// app shell
<ItxProvider>
  {" "}
  // ONE WebSocket per tab, global context,
  <App /> // session-cookie auth, reconnect w/ backoff,
</ItxProvider>; // exposes status: connected|reconnecting|error

// anywhere
const itx = useItx(); // global handle (typed Itx)
const project = useProjectItx(); // narrowed handle, cached per
// $projectSlug route param

// data: thin TanStack Query bridge — the typed handle IS the contract
const streams = useItxQuery({
  queryKey: itxKey.project(slug, "streams", "list"),
  queryFn: (itx) => itx.streams.list(),
});
const create = useItxMutation({
  mutationFn: (itx, input: { streamPath: string }) => itx.streams.create(input),
  invalidates: [itxKey.project(slug, "streams")],
});
```

Contents: provider + connection core (connect/reconnect/dispose, derived-handle
cache), `useItx`/`useProjectItx`, `useItxQuery`/`useItxMutation`, `itxKey` key
conventions (the `orpc.x.key()` replacement). Deliberately NOT in scope yet:
stream subscriptions (Step D), SSR seeding via `getServerItx` (later step —
pilot pages render client-side first paint with a loading state, fine for POC),
error-code rehydration (plain Error messages until `ItxError` lands in the
kernel step).

## Step C — pilot view #1, query-shaped: the streams page (~small PR)

`routes/_app/projects/$projectSlug/streams/index.tsx` converts to Step B's
library. Chosen because **its entire surface already exists on the handle**
(`itx.streams.list`, `itx.streams.create`) — no facades, no kernel work; the
only oRPC procedures it uses (`project.streams.list/create`) lose their last
UI consumer. This PR is the template others copy: what a converted route diff
looks like, where keys live, how mutations invalidate.

## Step D — pilot view #2, the new style: a live stream view (~2 PRs)

The flagship "looks like the new style" view — the seed of the canonical
`<StreamView>` from the big plan:

1. **Kernel**: `itx.streams.get(path).subscribe(callback, { afterOffset })` —
   bridge the browser's capnweb callback to the Stream DO's existing
   `subscribe({ processEventBatch, replayAfterOffset })` RPC (the exact
   mechanism today's oRPC `streamEvents` handler uses,
   `orpc/routers/streams.ts:141`). Returns a disposer. One built-in, ~80 LOC,
   plus an itx e2e test.
2. **React**: `useStreamEvents(path)` on the provider's subscription
   multiplexer (one server subscription per path, refcounted fan-out,
   re-subscribe-from-offset on reconnect), then convert the project stream
   detail view (`ProjectStreamView`) to: `read()` last page → live tail via
   subscribe, per-event-type renderers, raw-mode toggle, client-side
   filtering (decided in the big plan). `project.streams.read` stays oRPC for
   the history page in this step if convenient — or moves too, since
   `itx.streams.get(path).read()` already exists; prefer moving it.

After D, the dashboard demonstrates both target shapes — query-bridge for
D1-backed lists, live subscription for stream-shaped views — and every
remaining route conversion is mechanical repetition of C or D.

## What this retires / sets up

- oRPC procedures with zero UI consumers after A+C+D: `test.*`, `ping`,
  `streams.getState`, `streams.list`, `streams.create`, `streams.read`,
  `streams.streamEvents` (+ codemode's 6 via the parallel work) — the
  contract shrinks by ~⅓ and **all three eventIterator streaming procedures
  are gone**, which is the hardest oRPC feature to replace.
- The client library and both view templates exist; the remaining work from
  `itx-everywhere-plan.md` (facades for secrets/integrations/hostnames/agents,
  `getServerItx` SSR, `ItxError`, route conversions, CLI run-code, final
  deletion) becomes parallelizable mechanical work.

## Open questions

1. Step B file location: `apps/os/src/itx/react/` (recommended — it's
   os-specific and imports the `Itx` type directly) vs a workspace package.
2. Step C scope: also convert the streams _create_ dialog's form validation
   (zod moves into the component per the decided convention) — yes?
3. Step D: convert `agents/streams/$.tsx` too while we're in there (it's the
   other ProjectStreamView consumer), or strictly one view per PR?
