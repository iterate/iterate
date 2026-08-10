---
state: todo
priority: high
size: large
tags: [os, streams, processors, itx, facets, sdk, userspace]
---

# Dual-mode stream processors: one authoring surface, placement as a knob

Successor to [stream-processors-as-facets](./stream-processors-as-facets.md) and
[facet-alarms-for-userspace-processors](./facet-alarms-for-userspace-processors.md).
Companion contract: [docs/stream-subscription-model-redesign.md](../docs/stream-subscription-model-redesign.md).

> Revision log
> - **r1:** initial.
> - **r2:** 4th goal (facet in _any_ DO); `ctx.exports` = built-in registry;
>   ergonomics = factory; **facet vs remote split into two actions.**
> - **r3:** liveState-must-stay-hibernatable invariant + e2e; corrected the
>   userspace source to the real repo-path+revision+entryPoint+className worker
>   ref (no invented "config-repo"/"stateless"); **filter derives from the
>   processor contract, not a hand-written pre-filter;** **cursor lives in the
>   processor host**; clarified `DeliveryExpression`.
> - **r4:** a "Worked examples" section with real codebase references
>   (the guestbook + github-ai-linter starter apps) and a full walk-through of
>   **forking the built-in agent processor into userspace** — showing it's a
>   copy of the unchanged class plus a dep-wiring block, with a built-in-vs-fork
>   dependency table.
> - **r5 (this):** folded the final review: **no CPU-watchdog / no demotion**
>   (ripped out); the userspace worker ref is the **existing**
>   `StatefulDynamicWorkerRef`, not a new alias; the `start` hint stays
>   **whatever it is today** (contract/config-derived); explained `/agents/main`.
>   **Part 2 (the `StreamProcessorDurableObject` base class) lands in the PR that
>   carries this doc** — the base sketch below now matches the shipped API
>   (`get processor()`, `State`-first generics, `ProcessorHostDeps`).

## Status (what's landed vs planned)

- **Landed (this PR):** Part 1 was already published (`StreamProcessor` +
  `iterate/processors/testing` fakes). **Part 2 — the
  `StreamProcessorDurableObject` base class — is implemented here**, with the
  three real `createProcessorHost` callers (guestbook + the two github-ai-linter
  workers) migrated onto it. No behavior change; no `CORE_STATE_VERSION` bump.
- **Planned (follow-up PRs):** Part 3 — the `facet-processor` / `wake-processor`
  action split, the userspace facet loader, and the contract-derived filter.
  That one bumps `CORE_STATE_VERSION` and resets prd, so it ships on its own.

## The ask (Jonas, 2026-08-07)

1. **A pure-JS `StreamProcessor` base class** — extends `RpcTarget` (capnweb),
   deps injected, trivially unit-testable. No DO, no storage, no bindings.
2. **A `StreamProcessorDurableObject` base class** wrapping it ergonomically.
   **One DO class per processor.** Built-in and userspace **written identically**.
3. **Placement is a property of the subscription event** — "run over there in
   another DO namespace" vs "run as a facet"; if facet, built-in export vs
   userspace loaded class. **The API and event shapes are the point of this doc.**
4. **Host a `StreamProcessorDurableObject` as a facet of _another_ DO** (an Agent
   DO, a userspace DO) with a little plumbing to feed it events ⇒ the base is
   **host-agnostic**.

---

## Part 1 — the pure processor: `StreamProcessor extends RpcTarget`

Pure logic + injected deps. Owns exactly: `reduce` (pure fold), `processEvent`
(side effects via `blockProcessorWhile`/`runInBackground`/`append`), and RPC
verbs (it _is_ the itx handle). `snapshot()` comes from the host's `reads`; the
subclass adds domain verbs. **~90% already true today**
(`packages/iterate/src/processors/stream-processor.ts`).

```ts
export abstract class StreamProcessor<Contract extends StreamProcessorContract, Deps>
  extends RpcTarget {
  constructor(protected readonly deps: StreamProcessorBaseDeps & Deps) { super(); }
  abstract get contract(): Contract;
  protected abstract reduce(args: ReduceArgs<Contract>): ProcessorState<Contract>;
  protected processEvent(_args: ProcessEventArgs<Contract>): MaybePromise<void> {}
  getRuntimeState(): MaybePromise<ProcessorRuntimeContribution> { return {}; }
}
```

Unit test without miniflare: drive `reduce`/`processEvent` with a
`StreamHandleFake`. **Deliverable:** publish the base + fakes from
`iterate/processors` (mostly re-exports).

---

## Part 2 — `StreamProcessorDurableObject`: ergonomic, host-agnostic

One DO class per processor. The base does the registry ceremony, the wake door,
the alarm multiplex, and reads. **Host-agnostic** (goal 4): the same class runs
as a facet of the Stream DO, a facet of another DO, or its own DO. Only the
**alarm adapter** (native vs parent-proxy) and **who calls `wakeStreamProcessor`**
differ per host.

This is the **shipped** shape (`sdk.ts`). `State` is the first generic (the
common customization; `Env` defaults). The host is built **lazily** on first
access — deliberately not a field initializer — so a subclass's `streamPath` /
`recovery` field overrides are already set when the host reads them (a base
field initializer runs *before* the subclass's, so an eager `#host` field would
capture the base defaults). The wake door is exposed as `get processor()` —
the exact node name the stream spine already dials.

```ts
export abstract class StreamProcessorDurableObject<
  State extends object = Record<string, unknown>,
  Env extends IterateEnv = IterateEnv,
> extends IterateDurableObject<Env> {
  protected abstract createProcessor(deps: ProcessorHostDeps): RegisterableProcessor;
  protected readonly streamPath?: string;     // fixed home stream, or learn from first wake
  protected readonly recovery: boolean = false;

  #memoHost?: ProcessorHost<State>;
  get #host(): ProcessorHost<State> {         // lazy: reads streamPath/recovery post-construction
    return (this.#memoHost ??= createProcessorHost<State>({
      ctx: this.ctx, env: this.env, path: this.streamPath, recovery: this.recovery,
      createProcessor: (deps) => this.createProcessor(deps),
    }));
  }

  get processor() { return this.#host.wakeProcessor; }              // the node the spine dials
  async alarm(info?: AlarmInvocationInfo) { await this.#host.handleAlarm(info); }
  protected snapshot() { return this.#host.snapshot(); }            // for the subclass's own reads
  protected registry() { return this.#host.registry(); }           // catch-up / live refresh
}
```

> **`liveState`:** the real `ProcessorHost` has no `liveState` member — live
> state is served by a `LiveStateRpcTarget` built from the registry (see
> `GuestbookApi`), not the host. The base exposes `registry()` so a subclass
> wires its own live-state RPC exactly as today; nothing new is invented here.

### Ergonomics — factory `createProcessor(deps)`; here is where deps come from

Two kinds of deps enter from two places:

- **Platform deps** `{ stream, path, projectId }` — **derived by the host, not
  authored.** `path`/`projectId` from the DO identity or first wake; `stream =
  itxProjectStream(this.env, path)`. This is _why_ it's a factory: they aren't
  known until the DO knows its stream.
- **Your deps** — clocks, clients, config — **you construct in the override off
  `this.env`** (the env bindings you pictured):

```ts
export class TranslatorDurableObject extends StreamProcessorDurableObject {
  createProcessor(deps) {                        // {stream,path,projectId} from the host
    return new TranslatorProcessor({ ...deps, now: Date.now,
      deepl: new DeepL(this.env.DEEPL_API_KEY) });   // your deps: wired HERE, off this.env
  }
}
```

No DI container, no late-binding proxy. `ProcessorStream` is an interface, so
tests inject a `StreamHandleFake` and never touch `this.env`.

### Invariant: a userspace facet must NOT pin the Stream DO (Jonas, r2 #1)

**Load-bearing.** A userspace processor hosted as a facet — and especially its
`liveState` subscribers (WebSocket live state) — **must leave the Stream DO
hibernatable.** We likely get this from the #2403 shared-socket-lane work (one
hibernatable liveState lane per host, no per-subscription pinning), but it
collides with the known workerd#6800 gotcha (**a facet with its own SQLite keeps
the parent non-hibernatable**, ~70–140s idle billing through the parent). So:

- The facet's progress store is small and must not, by existing open, hold the
  parent up; verify the hibernation math per-facet.
- **Required e2e (fail-against-pre-fix):** open a userspace facet processor with
  a live `liveState` subscriber, go idle, and assert the Stream DO **hibernates**
  (no non-hibernatable duration accruing, no pinned lane). This is the test that
  keeps facets from silently re-introducing the pinning we just removed.

---

## Worked examples (real code in this repo)

### Ex. 1 — a processor **today** (the real guestbook)

This already exists and is the pattern the base class formalizes.
`packages/iterate/src/starter-apps/guestbook/processor.ts`:

```ts
export class GuestbookProcessor extends StreamProcessor<GuestbookProcessorContract> {
  get contract() { return GuestbookProcessorContract; }
  protected reduce({ state, event }) {
    if (event.type === "events.iterate.com/guestbook/entry-signed")
      return { entries: [...state.entries, event.payload] };
    return state;
  }
}
```

`packages/iterate/src/starter-apps/guestbook/worker.ts` — note it **already uses
the factory** `createProcessor(deps)` (the ergonomics we picked):

```ts
export class GuestbookApp extends IterateDurableObject {
  #host = createProcessorHost<GuestbookState>({
    ctx: this.ctx, env: this.env, path: guestbookStreamPath,
    createProcessor: (deps) => new GuestbookProcessor(deps),
  });
  async alarm(info) { await this.#host.handleAlarm(info); }
  get processor() { return this.#host.wakeProcessor; }
}
```

### Ex. 2 — the same on the base class (the boilerplate collapses) — **shipped in this PR**

This is exactly how the real `GuestbookApp` reads after the migration in this PR:

```ts
export class GuestbookApp extends StreamProcessorDurableObject<GuestbookState> {
  protected readonly streamPath = guestbookStreamPath;                 // fixed home stream
  protected createProcessor(deps: ProcessorHostDeps) {
    return new GuestbookProcessor(deps);
  }
  // alarm(), the `processor` wake door, snapshot(), registry() — all inherited;
  // only the HTTP/API + append verbs (sign/syncEvent/fetch) remain hand-written.
}
```

The two github-ai-linter workers migrate the same way — they set
`protected readonly recovery = true;` (no fixed `streamPath`; they learn their
stream from the first wake) and wire their itx-backed deps in `createProcessor`.

### Ex. 3 — a userspace processor that uses platform capabilities (real)

`packages/iterate/src/starter-apps/github-ai-linter/worker.ts` shows the exact
recipe for wiring userspace deps: **capture `this.env.ITX` and pass
capability-backed functions into the processor.**

```ts
#host = createProcessorHost({
  ctx: this.ctx, env: this.env,
  createProcessor: (deps) => new GithubAiLinterProcessor({
    ...deps,                                        // platform deps from the host
    publishReview: async (analysis) => {           // a userspace dep, wired off this.env.ITX
      using itx = await this.env.ITX.get();
      return await publishGithubAiLinterReview(itx, analysis);
    },
  }),
});
```

This is the whole trick behind the fork below: **the processor takes deps; the DO
wires them from `this.env.ITX` (itx capabilities) and its own env.**

---

## Forking the **agent processor** into userspace (Jonas's question)

Short answer: **you change zero lines of the agent processor's logic. The only
difference is ~15 lines of dependency wiring, because the processor is already
dependency-injected.**

Why: `apps/os/src/domains/agents/agent-processor-implementation.ts:119` is
already `class AgentProcessor extends StreamProcessor<AgentProcessorContract,
AgentProcessorDeps>`, and **every dep is optional and injectable**:

```ts
export type AgentProcessorDeps = {
  ai?: WorkersAiBinding;
  cloudflareAiGatewayTransport?: () => CloudflareAiGatewayTransport;
  resolveModelFileUrl?: (file: AgentFileAttachment) => Promise<string>;
  writeWorkspaceFile?: (input: { content: string; path: string }) => Promise<{ absolutePath: string }>;
  callLlm?: AgentLlmTransport;   // ← inject your own model transport (the unit test does exactly this)
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};
```

### Step 1 — copy the class into your repo, unchanged

Copy `agent-processor-implementation.ts` + `agent-processor-contract.ts` into
your config repo (or `import` them if we publish them). **No edits.** `reduce`,
`processEvent`, the tool loop — byte-identical.

### Step 2 — write a `createProcessor` that wires the deps from userspace

The **only** thing that differs from the built-in is where the four real deps
come from. Built-in wiring lives in `#registerAgent`
(`processor-facet-durable-object.ts`); the userspace fork wires the same deps
from itx + your own key:

| Dep | Built-in (`#registerAgent`) | Userspace fork (`createProcessor`) |
|---|---|---|
| LLM (`callLlm` / `ai` / `cloudflareAiGatewayTransport`) | `this.env.AI` + `parseConfig(this.env).cloudflareAiGateway` — the platform AI Gateway (unified: no key, or BYOK) | inject `callLlm` with your own transport, keyed by a project secret (`this.env.OPENAI_API_KEY`) |
| `resolveModelFileUrl` | `mintProjectFileUrl({ config, projectId, … })` (internal signer) | `(file) => (await itx.files.get(file.path)).url()` — the public itx equivalent |
| `writeWorkspaceFile` | `this.env.WORKSPACE_V2.getByName(…).writeFile(…)` (platform DO) | `({ path, content }) => itx.workspace.writeFile(path, content)` |
| `stream` / `path` / `projectId` | from the host | from the host — **identical** |

```ts
// In your config repo. The class it constructs is the UNCHANGED AgentProcessor.
export class MyAgentDurableObject extends StreamProcessorDurableObject {
  createProcessor(deps) {                                  // {stream,path,projectId} from the host
    const itx = () => this.env.ITX.get();
    return new AgentProcessor({
      ...deps,
      // 1. Bring your own model. `callLlm` short-circuits the platform gateway.
      callLlm: makeOpenAiTransport(this.env.OPENAI_API_KEY),
      // 2. File URLs via the public itx surface instead of the internal signer.
      resolveModelFileUrl: async (file) => (await (await itx()).files.get(file.path)).url(),
      // 3. Workspace writes via itx instead of the WORKSPACE_V2 binding.
      writeWorkspaceFile: async ({ path, content }) => {
        using p = await itx();
        await p.workspace.writeFile(path, content);
        return { absolutePath: path };
      },
    });
  }
}
```

### Step 3 — point a subscription at it

Flip the agent stream's processor subscription from the built-in to your fork —
one config event, no code deploy on the OS side:

```jsonc
{ "type": "events.iterate.com/stream/subscription-configured",
  "payload": { "name": "agent",
    "receiver": { "action": "facet-processor",
      "source": { "kind": "userspace", "worker": {
        "type": "stateful", "className": "MyAgentDurableObject",
        "path": "/agents/main",   // ← the STREAM path this worker hosts, i.e. the agent
                                  //   conversation stream. It is the `path` field of the
                                  //   StatefulDynamicWorkerRef — the same coordinate the
                                  //   host hands createProcessor as `deps.path`. Facet
                                  //   identity is the subscription name ("agent"); this
                                  //   only names which stream the class folds.
        "source": { "createWorker": {
          "files": { "type": "repo", "repoPath": "/repos/config", "ref": { "commitOid": "…" } },
          "entryPoint": "agents/my-agent.ts" } } } } } } }
```

### What you DON'T get for free (the honest caveats)

- **The unified AI Gateway** (no API key, platform-subsidized) is a first-party
  perk. Your fork brings its own key and cost — that's the `callLlm` line.
- The built-in registers **sibling** processors next to `AgentProcessor`
  (`ChatReplyNotifyProcessor`, `SlackAgentProcessor` — see `#registerAgent`). A
  fork gets the core agent; if you want the chat-reply push or Slack
  presentation, you port those too (they're the same shape) or subscribe them
  separately.
- Any dep with **no itx equivalent** is the real boundary. For the agent, all
  four have public equivalents, so a full fork works. A processor that reached a
  raw internal binding with no itx surface could not be forked without exposing
  that surface first.

**Net:** first-party and userspace really are "written the same way" — the fork
is a copy of the class plus a different dep-wiring block. The dependency
injection that makes the processor unit-testable is the same seam that makes it
forkable.

---

## Part 3 — the subscription event: facet vs remote are DIFFERENT ACTIONS

Facet delivery is an in-process function call — the Stream DO already holds the
events and hands a batch to a colocated facet: **no wake lane, no expression, no
delivery policy, no ack window, no retained callbacks.** Remote delivery is the
wake lane (dial another DO). So they are **two receiver actions**, and the wake
lane survives only for the remote one.

### `DeliveryExpression`, clarified (r2 #2)

It's an **itx expression** (an `ItxExpression` — the same address-path capnweb
uses everywhere) whose final step names the method to invoke, e.g.
`["projects", "myProcessorDo", "wakeStreamProcessor"]`. The stream builds a call
from it and dials that DO stub's method over RPC. It only appears on the
**remote** action.

### The filter is the contract, not a hand-written pre-filter (r2 #4)

A processor already declares what it consumes (`contract.consumes`). So a
processor subscription carries **no hand-authored `filter`** — the effective
wake filter **is** the contract's `consumes`. Built-in: resolved immediately
from the registered contract. Userspace: snapshotted from the loaded class's
contract at configure time (and re-resolved on version change). (Hand-written
`filter` stays only on the contract-less delivery actions: copy / itx-call /
webhook.)

### Correct worker source (r2 #3, #5, #6)

My r2 example was wrong. A processor written as a DO class is a **stateful**
worker ref (it names a `className`), and its code source is the real
repo-path + revision + entry-file shape — **any** repo (the config repo
`/repos/config` is just one of possibly many), not an invented `"config-repo"`:

```ts
// a userspace processor class, referenced exactly like any dynamic worker:
{
  type: "stateful",                       // names a DurableObject CLASS (not "stateless")
  className: "GuestbookDurableObject",    // the export to host
  path: "/guestbook",
  source: { createWorker: {
    files: { type: "repo",
      repoPath: "/repos/config",          // r2 #5: any repo path + revision
      ref: { commitOid: "abc…40hex" } },  //        pinned revision
    entryPoint: "processors/guestbook.ts" // r2 #6: which file in the repo
  } },
}
```

> **Naming tension — RESOLVED (r5): option (a), the existing concept exactly.**
> The userspace ref is the existing `StatefulDynamicWorkerRef`, kept
> hosting-neutral: today `type: "stateful"` implies `StatefulWorkerDurableObject`
> hosting, but here the **action** decides hosting (facet vs own-DO) and the ref
> only names "which class, from which source." No new `ProcessorClassRef` alias.
> `durableWorkerKey` stays an own-DO-only field (facet identity is the
> subscription name).

### The receiver actions

```ts
const FacetProcessorSource = z.discriminatedUnion("kind", [
  // BUILT-IN: `ctx.exports` IS the registry — this is just a POINTER into it.
  z.strictObject({ kind: z.literal("builtin"), className: z.string() }),
  // USERSPACE: the stateful worker ref above (class + repo source + revision + entry).
  z.strictObject({ kind: z.literal("userspace"), worker: StatefulDynamicWorkerRef }),
]);

export const SubscriptionReceiver = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("facet-processor"), source: FacetProcessorSource }),
                              // no filter (contract.consumes), no delivery (in-process call)
  z.strictObject({ action: z.literal("wake-processor"), expression: DeliveryExpression }),
                              // no filter (contract.consumes); cursor lives in the host, see below
  z.strictObject({ action: z.literal("copy-to-stream"), /* filter + delivery */ }),
  z.strictObject({ action: z.literal("itx-call"),       /* filter + delivery */ }),
  z.strictObject({ action: z.literal("webhook-post"),   /* filter + delivery */ }),
]);
```

### The three config events, concretely

**Facet, built-in** (pointer into `ctx.exports`; filter from the contract):

```jsonc
{ "type": "events.iterate.com/stream/subscription-configured",
  "payload": { "name": "capability-host",
    "receiver": { "action": "facet-processor",
      "source": { "kind": "builtin", "className": "CapabilityHostProcessorFacet" } } } }
```

**Facet, userspace** (real worker ref; no hand-written filter):

```jsonc
{ "type": "events.iterate.com/stream/subscription-configured",
  "payload": { "name": "guestbook",
    "receiver": { "action": "facet-processor",
      "source": { "kind": "userspace", "worker": {
        "type": "stateful", "className": "GuestbookDurableObject", "path": "/guestbook",
        "source": { "createWorker": {
          "files": { "type": "repo", "repoPath": "/repos/config",
                     "ref": { "commitOid": "abc…40hex" } },
          "entryPoint": "processors/guestbook.ts" } } } } } } }
```

**Remote wake** (processor in another DO; own-DO, or a facet of another DO):

```jsonc
{ "type": "events.iterate.com/stream/subscription-configured",
  "payload": { "name": "translator",
    "receiver": { "action": "wake-processor",
      "expression": ["projects", "translatorDo", "wakeStreamProcessor"] } } }
```

### Delivery routing — note how little the facet path is

```ts
switch (row.receiver.action) {
  case "facet-processor": {
    // ctx.exports IS the registry; userspace loads the class from its build.
    const klass = row.receiver.source.kind === "builtin"
      ? this.ctx.exports[row.receiver.source.className]
      : await this.#loader.getDurableObjectClass(row.receiver.source.worker);
    const facet = this.ctx.facets.get(row.name, () => klass);
    return facet.wakeStreamProcessor(batchFor(row));   // in-process; can't "not deliver"
  }
  case "wake-processor":
    return dialExpression(row.receiver.expression).wakeStreamProcessor(batchFor(row));  // the lane
}
```

### Where the cursor lives — RECOMMENDATION (r2 #8)

**The processor host owns the authoritative cursor** — its
`durableObjectProgressStore`, keyed by the subscription name — for **both**
actions, exactly as processor-wake works today and matching your instinct
("the stream processor DO should be where the cursor is stored"):

- **facet-processor:** the facet's progress store lives in the Stream DO's own
  storage (facet SQLite), but is owned by the facet — physically in the stream
  DO, logically the processor's.
- **wake-processor:** the progress store is in the remote processor DO.

The **source stream keeps only a lightweight mirror** (a `confirmed_offset` per
subscription) for two jobs: deciding when to wake, and showing lag
(`head − confirmed`). The mirror is advanced by the wake response's reported
checkpoint; it is never authoritative. This is why processor actions carry **no
copy-style `delivery` cursor** — the host owns the checkpoint. The `start`
hint (begin at head vs beginning) stays **whatever it is today** — the runner
already derives it from the contract/config, so the split does not touch it
(r5: "whatever is currently the case").

### Goal 4 falls out for free

"Facet in another DO" = that DO makes a `wake-processor` subscription pointing at
itself, receives batches over the lane, and calls its own hosted
`facet.wakeStreamProcessor(batch)` in-process. Host-agnostic base ⇒ it doesn't
care whether the batch arrived in-process or over the lane. No new event type.

---

## Wiring & safety

- **`ctx.exports` is the built-in registry** — `facet-processor{builtin}` is a
  pointer into it; no separate allowlist. Authority stays platform-only for
  built-ins.
- **Userspace facet authority:** allowed for a caller who owns the
  project/stream, only for that project's own repo build. Safe because a Stream
  DO is per-`(projectId, path)` — a bad userspace facet stalls only the
  project's **own** stream.
- **No watchdog, no demotion (r5).** We are **not** building a CPU-watchdog that
  rewrites `facet-processor` → `wake-processor` under load. The per-project blast
  radius above is the containment story; a runaway userspace facet degrades only
  its own project's stream, and the operator flips placement by config if needed.
  If any watchdog scaffolding sneaks in, rip it out.
- **Thread-sharing is worth *knowing*, not *policing*:** whether a loaded facet
  (`getDurableObjectClass().fetch()`) runs on the caller DO's OS thread or its
  own is useful platform knowledge for sizing the loader work — but it no longer
  gates a watchdog, so it is not a blocker for Part 3.

## Migration — clean break, **no back-compat cruft** (r2 #7, confirmed)

1. ✅ Publish Part 1 base + fakes — **already done** (`StreamProcessor` +
   `iterate/processors/testing` ship today).
2. ✅ **`StreamProcessorDurableObject` base; move `createProcessorHost` callers
   onto it — THIS PR.** No behavior change.
3. `facet-processor` / `wake-processor` split; **bump `CORE_STATE_VERSION`,
   rewrite birth batches, no compatibility shim** (prd resets).
4. Convert each built-in family from the `#registerProcessors` path `switch` into
   a seeded `facet-processor{builtin}` subscription (literally seeding pointers
   into `ctx.exports`); delete the `switch`.
5. Userspace loader branch + authority scope. **No watchdog.**
6. E2e: config-repo processor as `facet-processor{userspace}`, flipped to
   `wake-processor` by config alone.

## Open decisions (need Jonas)

1. **Action naming:** `facet-processor` / `wake-processor` vs alternatives.

(Resolved in r5: worker-ref stays the existing `StatefulDynamicWorkerRef` —
option (a), the existing concept exactly; `start` hint stays whatever it is
today; no watchdog, so the thread-sharing probe is informational, not a gate.)

## Resolved
- Ergonomics = factory `createProcessor(deps)`; deps story spelled out; no sugar.
- `ctx.exports` = built-in registry; no allowlist.
- Facet vs remote = two actions; facet path carries no lane.
- Goal 4 needs no new event type.
- Filter = `contract.consumes`, not hand-written (processor actions).
- Cursor = processor host owns it; source keeps a mirror.
- Userspace source = the **existing** `StatefulDynamicWorkerRef` (option a, r5),
  hosting-neutral; no new `ProcessorClassRef` alias.
- `start` hint = whatever it is today (contract/config-derived); the split
  doesn't touch it (r5).
- **No CPU watchdog / no demotion (r5)** — per-project blast radius is the whole
  containment story; thread-sharing is informational, not a gate.
- Clean break, no back-compat cruft.
- **Part 2 base class = shipped in the PR carrying this doc** (`get processor()`,
  `State`-first generics, `ProcessorHostDeps`, lazy `#host`).

## Testing strategy
- **Pure processor:** vitest, no miniflare — the bulk of userspace testing.
- **DO base (this PR):** a real-workerd (Miniflare) test drives an event through
  a `StreamProcessorDurableObject` subclass's wake door and asserts the fold via
  `snapshot()`, plus that a subclass's `streamPath`/`recovery` field overrides
  take effect (the lazy-`#host` ordering guard). Migration is otherwise covered
  by the existing starter-app processor tests staying green.
- **Hibernation invariant (Part 3, required, r2 #1):** userspace facet + a live
  liveState subscriber → idle → assert Stream DO hibernates (no pinning, no
  accruing non-hibernatable duration).
- **Placement/loader (Part 3):** real-workerd test loading a userspace class as a
  facet and waking it in-process. (Thread-sharing is a standalone experiment,
  informational only — no watchdog rides on it.)
- **E2e (Part 3):** config-change flips `facet-processor` ⇄ `wake-processor`.
