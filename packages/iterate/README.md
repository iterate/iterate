# iterate

The SDK for Iterate (`apps/os`): context APIs, stream processors, reactive clients, React
bindings, and OAuth app sessions, under `iterate/*`. The package exports source in this
workspace and compiled JavaScript with declarations when packed. The `iterate` command is
[`@iterate-com/cli`](../cli/README.md).

## The SDK/platform line

The SDK holds what user code runs or speaks, and the platform is its first user: apps/os builds
its own entities on `iterate/sdk`, and the first-party apps' code uses only `iterate/*`. Each
subpath in `package.json`'s `exports` is one public module; nothing else is importable.

- A module belongs here when user code runs it or speaks it: a loaded worker, a facet, a
  processor, a browser or Node client, or the wire contract between them and the platform. It
  belongs in apps/os when only the platform's Worker runs it, and in packages/shared when more
  than one app needs it and user code never does.
- Outside apps/os, no package and no app imports apps/os. `import-js/no-restricted-paths` in
  `.oxlintrc.json` resolves each import under `packages/**` and `apps/**` to a file, so type
  imports, re-exports, dynamic `import()` and an app added later are covered, and
  `lint/oxlintrc-platform-line.test.ts` pins it. Tests may import apps/os's two harnesses,
  `apps/os/e2e/support/` and `apps/os/__workers-tests__/support.ts`, which drive a real platform.
- No private core package behind a thin `iterate`: apps/os would then import modules user code
  cannot, and the SDK's types would have to be bundled or published anyway.

The decision's reasons, and how workerd, the Agents SDK, Convex,
Supabase, tRPC, Hono and Wrangler draw the same line:
[the decision record](https://github.com/iterate/iterate/blob/d52a4e8e0f791c96b683fe178b56570532123c05/docs/2026-09-24-sdk-platform-line.md)
(#3018).

## Reaching the context from loaded code

Code the platform loads for a project (a config worker, a facet, a worker behind a rewrite rule)
imports the SDK as `iterate/sdk` and reaches its context through `withItx`: one round trip,
after which the scope, every call made through it and every handle it awaited are released.

```js
import { ConfigWorker, withItx } from "iterate/sdk";

export default class extends ConfigWorker {
  async fetch() {
    // An SDK host (ConfigWorker, StreamProcessorDurableObject) has it as a method.
    const { projectSlug } = await this.withItx((itx) => itx.whoami());
    return new Response(`Homepage of ${projectSlug}`);
  }
}

// Anywhere else: withItx(this.env.ITX, (itx) => itx.kv.get("key"))
```

Never keep what `env.ITX.get()` hands out, and answer data, not handles, from `withItx`: a kept
scope, step or handle keeps the context, and any facet holding it, resident after the project goes
idle. An object that needs
reach takes a `WithItx` accessor (`(call) => withItx(this.env.ITX, call)`), never a scope; work
that outlives the call runs under a processor's `runInBackground` claim. Lint refuses a raw
`ITX.get()` in this repository (`iterate/no-raw-itx-get`).

## Testing a processor

`iterate/stream/test-support` (Node) is the harness the SDK's own engine tests use:

```ts
import { reduceProcessor } from "iterate/stream/test-support";

// apps/os/e2e/support/presence/processor.test.ts: durable ticks are reduced, ephemeral pokes are not
const state = reduceProcessor(new PresenceProcessor(), [{ type: "tick" }, { type: "poke" }]);
// state.ticks === 1
```

`memoryStream`, `memoryStorage` and `settle` drive a whole `ProcessorEngine` against an
in-memory log (`src/stream/processor.test.ts` shows how).

## Node connections

`iterate/node` exposes a connection owner for Iterate scripts and live
providers. It uses the same protocol and cleanup as the CLI:

```js
import { connectIterate } from "iterate/node";

using connection = await connectIterate({
  baseUrl: "https://os.iterate.com",
  auth: { type: "bearer", token: process.env.ITERATE_BEARER_TOKEN },
});
using project = await connection.session.projects.get("my-project");
console.log(await project.run("async (itx) => await itx.whoami()"));
```

## Event types

A platform event type is `events.iterate.com/<namespace>/<event>`: one namespace segment and one
event segment, both lowercase kebab-case, and never a third segment.

Every type under `events.iterate.com/` follows these rules, test types included. A type without
that prefix belongs to whoever appends it and is opaque to the platform: tests use types like
`demo/ping` on purpose, and a project may use its own domain (`events.garple.com/sales/…`).

### Namespaces

- **`itx`** holds the context engine's own events: everything the core contract
  (`apps/os/src/stream/core-processor.ts`) reduces, validates or refuses, plus the records the
  Stream, the context Durable Object and the SDK processor host write themselves. Where the schema
  and the reduce live decides it, not which contexts hold the event: fetch routes and the apex
  ingress target are core state, so they are `itx` even though only a project root's copy is read.
  A domain processor may consume an `itx` event (the agent consumes `itx/run-*`, the Project
  processor `itx/ingress-configured`); it names the core's catalog in its `processorDeps` rather than
  defining the event itself. The core's checkpoint slug is `core`: it is a storage key, not a type
  prefix.
- **A domain namespace** is the singular name of the kind of context whose log the event belongs
  to, which is the defining contract's slug when there is one: `account`, `organization`,
  `project`, `repo`, `workspace`, `secret`, `agent`, `voice-agent`. A fact cross-posted to another
  log keeps its own namespace: `repo/created` on `/` is still a repo fact.
- **An integration** uses its own name as its namespace, for example `chrome`, `slack`, `google`,
  `github`.
- **`test`** holds types that only tests append. Production code never matches a `test/*` type. A
  test contract may keep a slug of its own (`counter`), but its events go under `test/`. A test must
  not borrow a production namespace for a type that does not exist.

### Event names

- **A fact is past tense**: `<object>-<verb-ed>`, or a bare `<verb-ed>` when the object is the
  namespace's own subject (`itx/created` is the context, `agent/paused` is the agent). The object
  comes first and is singular.
- **Spell words out.** Clipped words are not allowed (`spk`); a real word is (`mic`), and so is an
  acronym the API already spells (`llm`, `rpc`, `itx`).
- **Asking and answering.** `<x>-requested` asks, and its offset identifies the ask. The answer
  takes one of three shapes:
  - `<x>-settled` is the one terminal fact when the asker reads a result. It names
    `requestOffset` and carries the outcome: succeeded, failed or cancelled, a status, or an error.
    Examples: `itx/run-*`, `agent/llm-request-*`, `project/hostname-add-*`.
  - `<verb-ed>` or `<verb>-failed` is used when success is a fact that other logs wait on, like a
    certificate: `create-requested` → `created` or `create-failed`, `delete-requested` → `deleted`,
    `hostname-remove-requested` → `hostname-removed`. A failure that is retried rather than
    reported gets no `-failed` fact.
  - An answer that is also a fact of its own names the ask by id:
    `voice-agent/delegation-requested` is answered by one `commentary-added` carrying its
    `delegationId`.
- **One verb pair per kind of change:**
  - `added` / `removed` for membership in a set: `organization/member-added`,
    `organization/project-added`, hostnames.
  - `created` / `deleted` for an entity with a lifecycle: projects, repos, workspaces, agents.
  - `set` / `deleted` for a keyed value: `secret/*`.
  - `set` / `cancelled` for a schedule: `itx/schedule-*`. Each occurrence is `fired` or `failed`.
  - `-configured` for one fact that sets a row or clears it with `null`
    (`itx/subscription-configured`, `itx/rewrite-rule-configured`, `itx/fetch-route-configured`),
    sets a singleton (`itx/ingress-configured`), or merges a partial configuration
    (`agent/configured`: omitted keys keep their values).
- **Things the platform does on its own** are plain facts about the object: `itx/schedule-fired`,
  `itx/schedule-failed`, `itx/subscription-delivery-halted`.
- **Ephemeral events.** An ephemeral event that records something happening is named like any other
  fact: `itx/rpc-stub-attached`, `itx/live-state-changed`, `chrome/navigated`. Three kinds may be
  singular nouns: a sequenced slice of a live stream is a `<stream>-frame`
  (`voice-agent/mic-frame`, `agent/llm-response-frame`), a heartbeat (`voice-agent/keepalive`), and
  a diagnostic record (`itx/alarm-trace`). A durable event is never a noun.
- **Families and prefixes.** Code matches some families by prefix: `…/itx/run-`,
  `…/itx/subscription-`, `…/itx/schedule-`, `…/project/hostname-`. Before naming a new type, check
  it doesn't join one of these families by accident. Never match `…/itx/` as a whole: it is not a
  permission boundary, and it catches live-state deltas, stub presence and child
  announcements.
- **Code follows the type.** A constant, schema, test fixture or idempotency key built from a type
  follows its name (`itx/child-created:<path>`). Broader concepts, modules and Workers log
  event names keep theirs: the Stream, scheduled appends, `core`, `scheduled-append.completed`.
- **Renaming.** A rename has to serve one of these rules, not taste. If a type is stored outside the
  platform's Durable Objects (device firmware, a published SDK, a project's config repo),
  rename it only in a change that migrates that store too.

| Namespace                                                           | Defined in                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `itx`                                                               | `apps/os/src/stream/core-processor.ts` (and its leaf event catalog), `stream.ts`, `scheduled-appends.ts`, `subscription-delivery.ts`, `apps/os/src/context/built-ins.ts`, `apps/os/src/fetch-routes.ts`, `apps/os/src/iterate-context-durable-object.ts`, `packages/iterate/src/stream/{run,processor}.ts` |
| `account`, `organization`, `project`, `repo`, `workspace`, `secret` | `apps/os/src/<name>/contract.ts` (repo and workspace also use `project/entity-lifecycle.ts`)                                                                                                                                                                                                               |
| `agent`                                                             | `packages/agents/src/contract.ts`                                                                                                                                                                                                                                                                          |
| `voice-agent`                                                       | `packages/voice/src/voice-agent.ts`, `packages/voice/src/events.ts`                                                                                                                                                                                                                                        |
| `chrome`                                                            | `apps/browser-extension/public/panel.js`                                                                                                                                                                                                                                                                   |
| `test`                                                              | tests only                                                                                                                                                                                                                                                                                                 |

Two types break these rules until one change migrates the Kit firmware and each project's pinned
`@iterate-com/voice` together: a device's firmware, voice.iterate.com and the project's pinned
voice must all use the same names.

- `voice-agent/spk-frame` will become `voice-agent/speaker-frame`.
- `voice-agent/conversation-ended` will become `voice-agent/call-ended`. It pairs with `call-started`
  and names the activation; the provider session is the `conversation`.

`note/added` is only an example in the Agents composer; no contract defines `note`.
`email/received` is only an integration's transcript in an agent UI test; no contract defines
`email`.
`capability-host/script-run-*` is never written to a log: the agent UI's adapter builds it in
memory.
