# What a userspace app like Docs needs that the clean room does not have (2026-09-04)

> Written against `packages/v3/project-worker` at the head of `wip/kernel-wayfinder-2026-07-30`
> (the memory-budget and builtins arcs, both uncommitted) and `apps/docs` +
> `packages/workspace-documents` on the same tree. Every claim about the clean room names the file it
> was read from. "Docs" below means the one app that `apps/docs` became when `apps/tasks` retired
> into it (#2390): a document lens and a task board lens over one project surface.

## 1. What the assessment is

The question: could the Docs app, the reference "remote app vessel" of `docs/remote-apps.md`, be
built INSIDE a project on the clean room, with real-time collaborative editing, a task board, and
commits, and if not, what exactly is missing. The method: read every call Docs makes on the OS
project stub (`apps/docs/src/rpc-api.ts`, `tasks-rpc-api.ts`, `config-bridge.ts`,
`packages/workspace-documents/src/server.ts` + `types.ts`), trace each to its OS implementation
(section 8 has the file, host and size of every lane), read the clean room's built-in scope
(`src/context/built-ins.ts`, `built-in-roots.ts`), its edge (`src/session.ts`,
`src/iterate-context.ts`, `src/worker.ts`), its loaded-code world (`src/itx-entrypoint.ts`,
`src/sdk/*`, `src/context/worker-loader.ts`), its DO fetch door
(`src/iterate-context-durable-object.ts`), the control plane (`packages/v3/control-plane/src/*`),
and the deployed e2e proofs (`e2e/*.e2e.test.ts`), then diff.

Two other apps were checked for the same class: `apps/streams-example-app` and `apps/tanstack`
(section 7). They need a strict subset of what Docs needs.

## 2. What Docs consumes from the platform today

Docs is three programs: a browser (TanStack Start pages, the shared CodeMirror collab editor), a
vessel worker (`apps/docs/src/worker.ts`, one capnweb `/api` root), and a few lines in the project's
config worker (`config-bridge.ts`). The vessel dials `os.iterate.com/api` back as the user and
forwards. Everything it forwards is one of these calls on the OS `project` stub:

| Lane            | Calls (as written in `rpc-api.ts` / `tasks-rpc-api.ts` / `config-bridge.ts`)                                                                                                                                                                                                       | What it is for                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| identity        | `os.authenticate({ type: "project-app-session", token })` / `{ type: "project-secret", projectSlug, secret }` → `session.projects.get(id)` → `project.identity()`; claims `userId/email/name/image` read from the token                                                            | act as ONE user (or as the project) on ONE project; `whoami` in the UI; commit attribution        |
| ingress         | `itx.auth.get({ policy: "project-member" }).fetch(request)` in the config worker; the `iterate-project-auth` cookie (15-min HS256, minted by the auth worker); `x-itx-project-id` stamped by ingress; `docs--<slug>.iterate.app` routed to the config worker; `itx.appUrl("docs")` | serve the app at `/` on a project host, members only; mint links to it                            |
| app exposure    | the config worker exports `DocsAppRpcTarget` as `itx.worker.docs` (`link()`); `DocsApp.create(env, { proxy: { origin, originOverrideKvKey } })` reverse-proxies to the vessel; `itx.kv.get(originOverrideKvKey)` flips the origin to a tunnel                                      | agents mint links; developers point production at a laptop                                        |
| workspace files | `project.workspaces.get(path)`: `create({})`, `exists`, `glob`, `readFile`, `readFiles` (≤10k paths), `writeFile`, `deleteFile`, `revert`, `readBase`; `/repos/**` mounts derived onto every workspace                                                                             | the file tree a board and a document live in; the overlay IS the diff                             |
| collab          | `workspace.collab.open / push({ baseVersion, clientId, epoch, ops }) / wait(path, epoch, afterVersion, clientId?, afterPresence?) / present / changes / versions / presenceSummary / boardViewers / boardPresent` (`packages/workspace-documents/src/types.ts`)                    | the `@codemirror/collab` rebase server: one ordering authority per file, long-poll `wait`, carets |
| git             | `workspace.git.status()`, `git.commit({ message, scope })`, `git.log({ limit, scope })`; `project.repos.list()`                                                                                                                                                                    | publish a mount's dirty set to the repo's main; the board's change cursor                         |
| streams         | `project.streams.list()` (the workspace picker); `streams.get(path).getEvents({ includeEphemeral })`; `.subscribe({ processEventBatch, replayAfterOffset })` → `{ unsubscribe, ping }`                                                                                             | the event sheet; the live board                                                                   |
| agents          | `project.agents.get(path).create()`, `.message(text)`, `.processor.snapshot()`                                                                                                                                                                                                     | `assignAgent`: frontmatter + one commit + birth + a kickoff brief                                 |
| secrets         | `/secrets/project-api-key` revealed once for the machine lane                                                                                                                                                                                                                      | headless apps authenticate as the project                                                         |

The browser never talks to OS directly: it holds the vessel's `DocsApi` over capnweb
(`apps/docs/src/lib/docs-client.ts`), and the vessel holds the OS project. That indirection exists
because the vessel is credential-free and the OS `/api` is the only place a user token is verified.

Two things the code says that the docs do not:

- `streams.get(path).subscribe({ processEventBatch, replayAfterOffset })` in `tasks-rpc-api.ts`
  has NO OS implementation. The OS `Stream` surface (`apps/os/src/rpc-targets.ts` `StreamRpcTarget`,
  `packages/iterate/src/itx-api.generated.ts`) has `openConnection({ processEventBatch,
replayAfterOffset, eventTypes, … })`; the vessel's call typechecks through an `as unknown` cast and
  would fail at runtime. The clean room's verb IS `subscribe`, so the name lands on the right side of
  the port.
- Commits are NOT attributed to the user today. `WorkspaceCommitInput.author` is caller-supplied,
  the vessel sends only `{ message, scope }`, and `workspace-core.ts` falls back to the iterate bot
  author. The human survives only in the collab redline (`collab_ops.client_id`). The clean room can
  fix this at the door (Gap 2), where OS never did.

## 3. What the clean room already has that this class of app wants

Read before the gaps, because most of Docs's server side is a straightforward userspace program on
these:

- **A durable class with its own storage, hosted by name** — `itx.facets.get(name, { source,
className })` (`built-ins.ts` `facets`), a real `DurableObject` subclass with `ctx.storage` (SQLite
  - kv) and `env.ITX`. The chatroom fixture (`e2e/support/sources.ts` `chatroom`) is the whole shape
    of a collab server: a class, a `LiveState`, methods reached by dotted calls. OS's collab server is
    the same shape inside `WorkspaceV2DurableObject` (`collab-engine.ts` 485 + `collab-host.ts` 711 +
    `collab-store.ts` 219 lines, four SQLite tables); that code is host-agnostic and ports into a facet.
- **Live state to every browser** — `LiveState.set(next)` diffs and appends one ephemeral
  `live-state/changed { key, from, to, patch }`; `itx.subscribe({ target: fn, consumes: [that type]
})` pushes it to any browser; the client chains revisions and re-reads the seed door on a gap
  (`src/stream/live-state.ts`, `src/client/live-state-client.ts`, proven live in
  `live-state-chains-client-side.e2e`). This is the board's presence dots, viewers strip and
  change cursor, for free.
- **Push to N browsers while the DO hibernates** — a lent callback is paged, never pinned
  (`rpc-stub-directory.ts`, `hibernation-at-scale.test.ts`). This is strictly better than what Docs
  has: OS's `collab.wait` parks an in-memory promise for up to 20 s per waiter per file per client
  on the caller's WebSocket and pins the workspace DO for the duration (`collab-host.ts`). On the
  clean room the ops ride ephemeral events to a paged subscriber and nothing is parked.
- **A fetch-shaped app served through the context, WebSocket upgrades included** — a loaded worker's
  `fetch` behind a rewrite rule answers `GET` and `101` (`fetch-door-expression-http-and-websocket.e2e`,
  `session-doors.e2e`); a laptop can lend the app over a tunnel (`fetch-door-tunnel-to-localhost.e2e`),
  which is a better version of Docs's `originOverrideKvKey` knob: one `provide`, no KV, per session.
- **Sharding by path** — `itx.cd('/workspaces/x')` is its own DO with its own log, facets and
  rules. One workspace per context is the natural tenancy, exactly what Docs's workspace DO is
  (OS also pairs one DO with one stream at the same path).
- **Throughput that covers OT** — ~100 durable appends/s awaited singly, ~2,900/s batched, per
  context (`docs/perf/2026-09-03-stress-ceilings.md`); an edit op is a few hundred bytes. The 8 MiB
  event ceiling (`stream.ts` `EVENT_BODY_MAX_CHARS`) is far above any document Docs accepts.
- **`itx.kv`** for the small knobs (the same use Docs makes of it), project-prefixed. OS's `itx.kv`
  is the same Workers KV under `projectkv:<pid>:<key>`.
- **Egress with secret substitution** (`{{secret:platform:NAME}}` through the control-plane shell,
  `{{secret:project:NAME}}` in the DO), so a fetch to any third-party API is a `fetch` in a loaded
  worker. `itx.ai` as `env.AI` verbatim is decided (2026-09-04) but not in the tree.
- **One-shot HTTP batch at `/api`** for CLIs and crons (`session-doors.e2e`), which is what a
  headless "vessel" needs.

## 4. The gaps, ranked by what blocks building Docs inside a project

The ranking is by "can the app exist at all without it", then by whether a userspace author can
work around it. Sizes are order-of-magnitude, in product lines, against the clean room's own
density (about 4.9k code lines for the whole worker after the builtins arc); the OS figure beside
each is what the equivalent lane costs in `apps/os` today (section 8).

### Gap 1 — no project-host ingress: an app cannot be served at `/` on a hostname

> **Closed 2026-09-06** by convention, no directory: `<label>--<projectId>.<base>` serves
> `itx.apps.<label>` of the project's root context, the apex `<projectId>.<base>` the label `default`,
> the Request verbatim through the fetch lane (`src/project-host.ts`, `worker.ts`; as-built §10
> "Project hosts", §12). Deployed under `*.project-worker.iterate.com`. Still missing from this gap
> as written: pretty slugs and custom domains (directory rows, the control plane's).

**Docs needs:** `https://docs--<slug>.iterate.app/w?repo=…` reaches the app with the URL verbatim,
relative asset links intact, cookies scoped to the host, WebSocket upgrades passing through.

**The clean room has:** the fetch lane at `/expression?context=<id>&itx=<expr>` (`worker.ts`), which
puts the routing in the query string, so every relative link on the served page breaks, and the
worker is a single workers.dev host. The control plane has the `routes` table (`host → { projectId,
app }`, `definitions.sql`) and `resolveHost` (`ingress.ts`), but the dial from a resolved host to a
project was deleted in cook-1 and `/__ingress` answers 503 (`app.ts`). The design is written and
parked: `docs/plan-one-fetch-rules.md` D1, "a label is the address": `itx.apps.<label>` resolved from
the request's host, the URL passed verbatim into the root context DO's `fetch`.

**OS today:** `apps/os/src/ingress.ts` (206 lines) parses `<app>--<slug>.<base>`, resolves the slug
through a KV directory, stamps `x-itx-project-id` and `x-iterate-app`, and `worker.ts` serves the
project's config worker, which dispatches on the app header.

**Missing:** the ~60-line edge branch in `worker.ts` (or the control plane) that maps `Host` to
`{ projectId, label }` by convention (`<label>--<slug>.<base>`, `<slug>.<base>`) plus directory rows,
strips inbound `x-itx-*`, and calls the root context's fetch with `x-itx-expression:
itx.apps.<label>` (the lane that already exists). Then a slug → projectId lookup the project worker
can make (today `projects.get` takes only the id). Size: small on the worker, plus one control-plane
RPC for slug and custom-domain resolution, plus a wildcard DNS + route on a real base domain.

**Why it is first:** without it there is no URL to put in Slack, no cookie domain, no `appUrl`, and
the TanStack app cannot load its own assets.

### Gap 2 — no identity: `authenticate()` is a no-op and nothing carries a user into a context

> **Closed 2026-09-06**, minimally: `authenticate({ projectToken })` verifies a signed project token
> (`src/principal.ts`; the control plane mints after its membership check), `session.whoami()` is the
> principal, `projects.get` is bound to the token's project, and the DO stamps `source.principal` on
> every event the session appends — its own field, a client's dropped. On a project host
> `/.itx/session` turns the token into the cookie and the app sees `x-itx-principal` (as-built §4
> "Who", §10, §12). Still open inside the gap as written: the login page and the born project
> credential (the control plane's and Gap 7's).

**Docs needs:** a member-only gate at ingress; a per-user session lane into the project API so the
vessel (or the browser directly) acts as that person; `whoami` claims for the UI; every commit and
event attributed to the real human; a machine lane for headless apps.

**The clean room has:** `UnauthenticatedSession.authenticate(_credentials)` returns the one session
regardless of its argument (`session.ts`), `projects.get(id)` is pure addressing with no membership
check, and `itx.whoami()` names the CONTEXT, not the caller (`built-ins.ts`). Events carry `source`
and `metadata` (`stream/events.ts`) but nothing stamps them. The control plane, separately, has the
whole front desk: an HMAC session cookie (`session.ts`, 30 days), a D1 directory with users, orgs,
memberships, `access(userId, projectId)`, hashed API keys with project grants (`directory.ts`,
`api.ts`), a `StampedCaller { actor, email, member, role }` (`ingress.ts`), and an OAuth AS on
`/mcp`. None of it reaches the project worker: the shell's `invokeCapability("itx.auth.gate")`
returns `{ ok: true }` unconditionally (`control-plane-shell/src/index.ts`).

**OS today:** ~880 lines across `auth/project-app-session-token.ts` (112, local HS256 verify),
`auth/project-auth.ts` (491, the cookie flow and sign-in pages), `apps/auth`'s mint (133, re-checks
membership live, 15-min JWT), `authenticate()` itself (~93). The principal becomes
`project-app-session:<userId>@<projectId>` and is stamped as `actor` on agent messages, but NOT on
commits (section 2).

**Missing, in the clean room's vocabulary:**

1. `authenticate(credentials)` verifies something: a control-plane session cookie or a short-lived
   project token (Docs's `project-app-session` shape) checked locally with a shared HMAC secret, or a
   project API key; and `projects.get(id)` refuses non-members (one call through `FALLBACK` to the
   directory, cached per session).
2. A principal on the session, stamped into every `append` the session makes (`source` or a
   `metadata.actor` the platform owns and a client cannot forge), and readable beside
   `itx.whoami()`. This is what makes "commits and audit trails carry the real human" true, and it is
   the one place the clean room would be ahead of OS rather than behind.
3. A member gate on ingress (Gap 1) that also mints the project-host cookie the app's WebSocket
   presents back, the `iterate-project-auth` role.
4. A born project secret and a write door for secrets (Gap 7) so the machine lane exists.

Size: medium. The verification is ~100 lines in `session.ts`; the stamp is a field in `append`'s
path; the gate is the ingress branch plus one directory call. The design questions (is the principal
an event `source`? does a loaded worker's `env.ITX` carry the user of the request that reached it?)
are the real work and are not decided anywhere in the tree.

**Why it is second:** the trusted-client doctrine makes intra-project authority open on purpose, but
"who did this" is not authority, it is attribution, and Docs is unusable without it (every card has
`createdBy`, every commit an author, every caret a name).

### Gap 3 — no file tree, no repo, no git

**Docs needs:** a workspace that is an overlay over `/repos/**` mounts with `readBase` (HEAD),
`writeFile`, `revert`, `glob`, `git.status/commit/log` scoped to a mount, and a repo catalog.

**The clean room has:** three stores and none of them is a file system: the append-only log (≤8 MiB
per event, `stream.ts`), `itx.kv` (Workers KV, eventually consistent, one flat project prefix,
`built-ins.ts`), and a facet's own DO SQLite/kv (`sdk/stream-processor-durable-object.ts`,
`ctx.storage`). No R2 or blob binding (`wrangler.jsonc` binds `LOADER`, `ITX_KV`, `SECRETS_KV`,
`ITERATE_CONTEXT`, `FALLBACK` and nothing else). No git anywhere; `docs/itx-surface-as-built.md` §12 F
explicitly parks "build from a repo" as "a build capability, not the loader door". Loaded isolates
run with `no_nodejs_compat` (`worker-loader.ts`), so userspace git code runs without Node polyfills.

**OS today:** the workspace overlay is `workspace-durable-object.ts` + `workspace-core.ts` + helpers
(~2,060 lines) over DO SQLite with an R2 spill for files over ~1.5 MB and a kv whiteout map; every
project repo is mounted at its own `/repos/**` path with `policy: "commit-to-main"`, derived from the
project processor's reduced `repos` list, never stored. Git is NOT isomorphic-git: `RepoDurableObject`
(2,319) + `lazy-repo-reader.ts` (571) + `git-wire.ts` (654) + `repo-object-store.ts` (298) speak git
protocol v2 over HTTP to a Cloudflare Artifacts remote, build the commit and pack locally, and push
with a CAS on the ref, with an `@cloudflare/shell/git` in-memory clone as the fallback lane. About
3,840 lines for git, ~265 more for the workspace-side `status/commit/log`.

**Missing, split in two because they are different decisions:**

- **Files:** buildable in userspace TODAY as a facet with a `files(path, content, base)` SQLite table
  and the collab sessions in the same class, which is what Docs's workspace DO is. A workspace = one
  context under `/workspaces/<name>` = one facet. What the platform would add is only a blob
  primitive for anything over the 8 MiB event / SQLite-cell comfort zone (an `itx.blobs` root over
  R2, ~80 lines, the counterpart of OS's `FILES_BUCKET` spill), which Docs itself does not need.
- **Git:** not buildable in userspace without a base. The OS mechanism is already "a fetch to a git
  remote" at its core; the port is the git-wire client (~1,225 lines of `lazy-repo-reader.ts` +
  `git-wire.ts`, to be checked against `no_nodejs_compat`) running in a loaded worker through egress
  with a remote credential in `SECRETS_KV`, against Artifacts or GitHub directly. That keeps the
  clean room free of a repo DO and is the `feedback_integrations_are_fetch_functions` shape. The
  "config worker from a repo" tier (`/repos/config` → a producer expression with the commit as
  `cacheKey`) is then the same fetch. Platform-hosted repos would be the full 3,840-line port and
  should not be the first cut.

**Why it is third:** the document lens works without git; the board's commit/publish flow and
`assignAgent` do not. A first cut of Docs on the clean room is "workspaces without mounts".

### Gap 4 — no timer that survives idle

**Docs needs:** presence entries expire (`boardPresent` heartbeats; OS sweeps a 45 s cut), the board
autosaves after 60 s idle (`use-task-commit.ts`, client-side today), collab sessions flush after 2 s
idle / 15 s max and end after 5 min idle (`collab-host.ts` `FLUSH_IDLE_MS`, `FLUSH_MAX_MS`,
`IDLE_END_MS`), a `wait` long-poll times out at 20 s.

**The clean room has:** in-isolate `setTimeout` works inside a facet while it is awake, and a facet
with work in flight pins its context (the accepted trade in `built-ins.ts`). What ends it: the
quiet clock aborts idle facets after 60 s (`iterate-context-durable-object.ts`
`IDLE_QUIESCE_AFTER_MS`), a facet call is aborted after 60 s (`FACET_CALL_WATCHDOG_MS`), and facets
have no alarm (workerd#6810, pinned in `sdk/stream-processor-durable-object.ts`: "a timer, when one
is needed, will be a scheduled append on the context, not an alarm here"). `waitForEvent({
timeoutMs })` (`stream.ts`) is the one bounded wait, and it filters by event type only. OS's collab
timers are the same in-isolate `setTimeout`s, kept alive because `wait` pins the DO.

**Missing:** the scheduled append that comment promises, as a built-in: `itx.append({ …,
deliverAt })` or `itx.schedule(atMs, event)`, reduced by core into a small table the DO's existing
alarm drains. ~80 lines in `stream.ts` + `core-processor.ts`. Every presence TTL, autosave and
session-idle rule in the app is then "append a tick to myself" and survives eviction. Until it
exists the app's timers die with the facet at 60 s of quiet, which for Docs means a flush-on-idle
that never fires after everyone leaves; a flush-on-every-accepted-push (the durable ops table IS the
document) avoids it. Friction, not a wall.

### Gap 5 — no catalog of a project's contexts

**Docs needs:** `streams.list()` → every workspace stream with `createdAt`, the picker's data source;
`repos.list()` for the board's per-repo sections.

**The clean room has:** `projects.get(id)` and `cd(path)` are pure addressing; there is no list of
which contexts exist (`session.ts`: "No `list`/`create` yet (owner: not now); when they come they
ride a deployment context's events"). The DO constructor does append `stream/created { projectId,
path }` at offset 1 of every context, so the fact exists, in the wrong place to enumerate.

**OS today:** both lists are reads of the project stream processor's reduced state
(`project-processor-implementation.ts`, 870 lines, `streams` and `repos` slices), not DO scans; every
stream announces to every ancestor path, which is why Docs prunes phantom ancestors client-side.

**Missing:** the root context (or `/`'s core reduce) receiving one `context/created` fact per child
on first materialization (the `ReachableContext` seam in `built-ins.ts` `cd` is where a child is
first named) and a `itx.contexts.list(prefix?)` root over it. ~60 lines. Workaround until then: the
app keeps its own index in its facet, which Docs's `createWorkspace` could do today.

### Gap 6 — the collab server's ergonomics: long-poll and replay are the client's job

Not a wall; listed because every app in this class re-implements it.

- `subscribe` has no `replayAfterOffset`; a live target is pushed only new commits and heals gaps
  with `read` (`subscription-delivery.ts`). Docs's `subscribeEvents(cb, afterOffset)` is `read` then
  `subscribe` with a dedupe on offset, client side; OS's `openConnection` does it server-side. A
  `replayAfter` on the row (the cursor lane already knows how) is ~30 lines.
- Push delivery to a browser is fire-and-forget behind an 8 MiB per-row backlog that drops the OLDEST
  (`subscription-delivery.ts`, landed 2026-09-04). For OT that is correct (the door is the truth), but
  the app must treat every delivery as lossy, which `workspace-documents`'s client already does
  (`onReseed`).
- A long-poll `wait` on a facet method is bounded by the 60 s facet call watchdog; OS's 20 s fits,
  but the better port is no `wait` at all: ops as ephemeral events, the browser a paged subscriber.
- `waitForEvent` filters by type only; per-document waiting needs a per-document context or a
  payload predicate. One-context-per-workspace with `consumes` on the subscription is enough.

### Gap 7 — no secrets write door, no born project credential

**Docs needs:** `/secrets/project-api-key` revealed once; the machine lane presents it.

**The clean room has:** `SECRETS_KV` read at egress only (`iterate-context-durable-object.ts`
`#egress`); nothing in `src/` writes it (the e2e seeds through wrangler). The control plane mints
user-scoped API keys with project grants (`app.ts` `/apikeys`), which is a different credential.

**OS today:** a 1,001-line `SecretDurableObject` that verifies the born key with a constant-time
compare inside the DO (`verifyMaterialField`).

**Missing:** `itx.secrets.set(name, value)` (write-only, as `ITX-KERNEL-SHAPE.md` sketched) and one
project credential minted at project creation the control plane can verify at `authenticate`. ~50
lines. Depends on Gap 2 for the verifying side.

### Gap 8 — the vessel's client contract has no home

Docs depends on `iterate/client` types (`Project`, `UnauthenticatedOs`, `ItxAuthCredentials`,
`packages/iterate/src/itx-api.generated.ts`) and a `Stream` shape. The clean room's doctrine is "the
client is just capnweb" (`iterate-context.ts` header), and the type of what a client holds is the
`IterateContext` interface merged with `BuiltInScope`. For an app authored outside this package that
type must be published; today it is importable only from the worker's own source. A `types.ts`
export map entry, no runtime. Trivial, but it is the first thing an app author hits.

### Out of scope but on Docs's path

- **Agents**: `agents.get(path).create/message/processor.snapshot` has no counterpart; on OS an agent
  IS a stream at `/agents/<name>` with a facet-hosted processor (`processor-facet-durable-object.ts`
  1,041 + the agent contract 932), which is exactly the clean room's `cd('/agents/x')` +
  `enableProcessor` shape. Docs only needs "append a message event to a sibling context", which
  `itx.cd('/agents/x').append(…)` already is.
- **AI**: Docs's "write commit message" button is deterministic string counting
  (`tasks-model.ts` `fallbackCommitMessage`); no AI call exists on that path today. When one does,
  `itx.ai` as `env.AI` verbatim is the decided shape.
- **The 15-minute membership staleness** of `docs/remote-apps.md` disappears if the browser holds the
  context directly instead of through a vessel; the trade is that the app's server logic must then be
  a facet in the project, which is the point of "apps inside a project".

## 5. Docs rebuilt on the clean room: the mapping

A sketch of the shape once Gaps 1 and 2 exist, to show how little of Docs's server is platform:

```
/workspaces/tasks--config--<boardId>      one CONTEXT per workspace (itx.cd)
  facet "workspace"                        one DurableObject class, own SQLite:
                                             files(path, content, base)   the overlay + readBase
                                             collab_ops / collab_snapshots / collab_sessions   OS's collab-store.ts, verbatim
                                             presence(path, clientId, anchor, head, at)
                                           LiveState "board"  → presence dots, viewers, versions
                                           every accepted push ALSO appends one ephemeral
                                             workspace/live-edit { path, version, ops }  (OS does the same)
  rule  itx.ws ⇒ itx.facets.get('workspace', { source, className: 'WorkspaceDurableObject' })
  subscription "board-live" (per browser)  target: the browser's callback,
                                           consumes: [live-state/changed, workspace/live-edit]

/  (root)
  rule  itx.apps.docs ⇒ itx.workers.get({ source: <the TanStack build>, cacheKey: <build id> })
        — or, while developing: itx.provide("itx.apps.docs", tunnelStub) from the laptop
  ingress: docs--<slug>.<base>/…  →  root DO fetch, x-itx-expression: itx.apps.docs  (Gap 1)
  the page's browser: /api → authenticate(cookie) (Gap 2) → projects.get(id).cd('/workspaces/…').ws.push(…)
```

What Docs's vessel does today in `rpc-api.ts` + `tasks-rpc-api.ts` (~800 lines of forwarding,
lazy-create, path qualification, owner-act checks) collapses to the facet's methods, because the
browser holds the workspace context itself and the forwarding layer has nothing left to forward.
`packages/workspace-documents` (the editor, the collab client, comments, redlines) moves unchanged:
its `WorkspaceDocumentLane` is five methods the facet implements verbatim, and `wait` becomes a
subscription. OS's `collab-engine.ts` and `collab-store.ts` are host-agnostic and are the facet's
first 700 lines.

The commit lane (`git.commit`) is the one method with no home until Gap 3 is decided.

## 6. Order of work, if the goal is "Docs runs inside a project"

1. **Ingress by host label** (Gap 1): the parked D1 design, the smallest edge change with the
   largest unblock. Prove: the site fixture served at `site--<slug>.<base>/` with a relative asset.
2. **Identity** (Gap 2): verify at `/api`, stamp the principal on appends, gate ingress. Prove: two
   browsers, two users, one board, each caret named; a non-member gets the login page.
3. **The workspace facet** in userspace (files + collab + presence), porting OS's engine and store —
   no platform change; ship the document lens. This is the moment to see whether Gap 4 (timers) and
   Gap 6 (replay) hurt enough to build.
4. **Contexts catalog** (Gap 5) for the picker, or the facet's own index.
5. **Git as a fetch** (Gap 3, the git-wire client in a loaded worker) for the board's publish flow;
   revisit only if the product needs platform-hosted repos.
6. **Secrets write door + born credential** (Gap 7) for the machine lane; the client types export
   (Gap 8) alongside.

## 7. The two smaller apps

Neither uses the OS project surface at all; both are standalone workers with their own Durable
Object, reached over capnweb directly. They matter here as the two ends of the class.

**`apps/tanstack`** (multiplayer todo lists): one `DurableObject` per list named by URL slug
(`src/worker.ts`), todos in DO SQLite through sqlfu (`src/todo-list.ts`), fan-out with
`iterate/sdk/capnweb`'s `LiveState` + `LiveStateRpcTarget`, the browser folding snapshot + patches
in `createLiveStateStore` (`src/lib/use-todo-list.ts`). No auth. The Playwright spec proves two
browsers converge without polling and survive a reload.

On the clean room this app is the chatroom fixture with a table: `itx.cd('/lists/<slug>')` is the
per-list DO, `itx.facets.get('todos', { source, className })` the class, `LiveState` (the clean
room's own, `src/stream/live-state.ts`, same diff-patch contract) the fan-out, `connectLiveState`
(`src/client/live-state-client.ts`) the browser side. Every server verb (`add`, `setDone`, `rename`,
`remove`) is a dotted call. The only things it cannot do today: be served at a URL (Gap 1) and know
who toggled the box (Gap 2). Zero platform work beyond those two.

**`apps/streams-example-app`** (the stream playground): imports OS's `StreamDurableObject` verbatim
and exposes it at `/api/streams` behind an admin-only OIDC gate (`src/worker.ts`,
`src/iterate-auth.ts`), mirrors the log into browser OPFS SQLite with one writer tab elected by Web
Locks, and calls `append`, `getEventPage`, `openConnection({ processEventBatch, replayAfterOffset,
eventTypes })`, `runtimeState()` (polled), `at(path)`, `kill()`, `reset()`.

On the clean room the log IS the primitive: `append` ≡ `itx.append`, `getEventPage` ≡ `itx.read`
(byte-budgeted, `highestDurableOffset` for at-head), `at(path)` ≡ `cd`, `runtimeState()` ≡
`itx.facets.get('core').snapshot()` + `itx.rpcStubs.list()` + `itx.subscriptions.list()`. Missing:
`openConnection`'s `replayAfterOffset` and `eventTypes` on one handle (Gap 6; `consumes` covers the
type filter, replay is client-side), the operator verbs `kill`/`reset` (the clean room evicts only
from `__workers-tests__/support.ts`), and the admin gate (Gap 2). The browser-side OPFS mirror is app
code and ports unchanged.

## 8. Sizes on the OS side, for calibration

What each lane Docs consumes costs in `apps/os` today, from the source (raw lines). The point of
the table: the platform gaps above (1, 2, 5, 7) are each a few hundred lines on OS; the two big
numbers (workspace + collab, git) are the two lanes the assessment says should be userspace or a
fetch, not clean-room kernel.

| Lane                                       | OS files                                                                                                                                            | Host                                         |  Lines | Storage                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -----: | -------------------------------------------------------------------------------- |
| `/api` door + host ingress                 | `apps/os/src/worker.ts`, `ingress.ts`                                                                                                               | stateless worker                             |    537 | KV `PROJECT_DIRECTORY` (slug → id, host → project)                               |
| `authenticate` (both lanes) + token verify | `rpc-targets.ts` L7468–7546, `auth.ts` L347–361, `auth/project-app-session-token.ts`                                                                | stateless worker                             |   ~205 | shared HMAC secret                                                               |
| project-host cookie flow + mint            | `auth/project-auth.ts`, `routes/api.$.ts`, `apps/auth/src/server/project-app-session.ts`                                                            | os worker + auth worker                      |   ~675 | cookie; auth DB membership check at mint                                         |
| `project-secret` verify                    | `domains/secrets/secret-durable-object.ts`                                                                                                          | `SecretDurableObject`                        |  1,001 | DO SQLite                                                                        |
| `identity()`, `appUrl()`, `projects.get`   | `rpc-targets.ts` L6607–6645, L5593–5680                                                                                                             | stateless worker                             |   ~130 | KV directory                                                                     |
| `itx.auth.get(policy).fetch()`             | `rpc-targets.ts` L6137–6180 (+ the cookie flow above)                                                                                               | stateless worker                             |     44 | —                                                                                |
| `itx.kv`                                   | `rpc-targets.ts` L8846–8942                                                                                                                         | stateless worker                             |     96 | Workers KV `projectkv:<pid>:<key>`, values ≤ 64 KiB                              |
| workspace RPC surface                      | `rpc-targets.ts` L2505–2776                                                                                                                         | forwarder                                    |   ~270 | —                                                                                |
| workspace overlay + fs                     | `domains/workspaces/workspace-durable-object.ts`, `workspace-core.ts`, `utils.ts`, `overlay-ignore.ts`, `paths.ts`                                  | `WorkspaceV2DurableObject`                   | ~2,060 | DO SQLite + R2 spill > 1.5 MB + kv whiteouts                                     |
| workspace config (mounts)                  | `workspace-processor-contract.ts`, `-implementation.ts`                                                                                             | facet on `StreamDurableObject`               |    234 | the workspace's stream                                                           |
| collab (engine + host + store + RPC)       | `domains/workspaces/collab-engine.ts`, `collab-host.ts`, `collab-store.ts`, `rpc-targets.ts` L2836–2927                                             | `WorkspaceV2DurableObject`                   | ~1,505 | DO SQLite: `collab_ops/snapshots/sessions/bases`; presence in memory             |
| `git.status/commit/log` (workspace side)   | `rpc-targets.ts` L2776–2836, `workspace-core.ts` L687–890                                                                                           | `WorkspaceV2DurableObject`                   |   ~265 | overlay + the repo DO                                                            |
| repo + git (`commitFiles`)                 | `domains/repos/repo-durable-object.ts`, `lazy-repo-reader.ts`, `git-wire.ts`, `repo-object-store.ts`                                                | `RepoDurableObject`                          | ~3,840 | Cloudflare Artifacts git remote (protocol v2) + DO SQLite object store           |
| `streams.list()` / `repos.list()`          | `rpc-targets.ts` L1429–1453, L1969–1991, `domains/projects/project-processor-implementation.ts`                                                     | facet on the project's `StreamDurableObject` |   ~915 | project stream reduced state                                                     |
| stream log + `openConnection` push lane    | `domains/streams/stream-durable-object.ts`, `stream-storage.ts`, `stream-subscriber-pager.ts`, `stream-event-sender.ts`                             | `StreamDurableObject`                        | ~6,800 | DO SQLite `events` + `event_chunks` + `subscription_cursors`; hibernatable pager |
| agents (`create/message/snapshot`)         | `rpc-targets.ts` L1991–2091, L4975–5354, `domains/processor-facet-durable-object.ts`, `domains/agents/agent-processor-contract.ts`                  | facet on the agent's `StreamDurableObject`   | ~2,450 | the agent's stream + facet checkpoint                                            |
| `env.ITX.get()` for loaded code            | `domains/itx/itx-entrypoint.ts`, `rpc-targets.ts` `itxForScope`                                                                                     | `WorkerEntrypoint`                           |   ~133 | —                                                                                |
| config-worker build/load/serve             | `domains/workers/worker-runner.ts`, `worker-loader.ts`, `project-serve.ts`, `artifact-store.ts`, `build-backend.ts`, `worker-build-coordinator*.ts` | `WorkerBuildCoordinatorDurableObject`        | ~1,575 | Worker Loader + KV artifact store; source from the repo DO                       |

Three findings from the trace that change the port:

1. **The vessel's live feed calls a verb OS does not have** (`subscribe`); the real lane is
   `openConnection`. The clean room's `subscribe` is the name to keep; give it replay (Gap 6).
2. **Commit authorship is the iterate bot today**, because `author` is caller data the vessel omits.
   Derive it from the principal at the door (Gap 2) rather than trust the caller.
3. **OS's `collab.wait` pins the workspace DO** (in-memory waiters, 20 s per call, no hibernation).
   The clean room's paged subscriber is the better shape, and it exists; the port should drop `wait`.
