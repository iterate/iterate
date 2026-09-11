# Userspace apps and dynamic builds

**Status: assessment, not an implementation plan.** This complements the
existing [clean-room assessment](../../project-worker/docs/assessment-userspace-apps-on-the-clean-room.md),
which was used as a lead and not changed. It checks the current
`project-core` against the retired Tasks-in-Docs implementation and adds the
dynamic TypeScript build question.

“Userspace” means a repo-addressed worker receives an explicit project
capability. It does not mean that arbitrary code obtains storage, identity,
secret material, route authority, or an execution engine.

**Public vocabulary should start with paths, not actor identifiers.** A path
names a project-local namespace such as `/tasks`, `/docs`, or `/docs/n.md`.
It is stable in links, routes, grants and event context. A platform may attach
a verified human/session actor to a commit when it has one, but callers should
not have to invent or expose a public actor ID merely to read or change a
project path. A signature level remains evidence about keys, not a user
identity.

## What is already usable

`src/worker.ts` gives a named context an ordered log, `append`, `readEvents`,
a WebSocket follower, mounted dynamic workers, and a raw fetch path.
`src/repositories.ts` gives immutable file-map commits plus a CAS-updated head.
`src/runtime.ts` resolves an inline map or immutable repo revision, clones it,
hashes it for Worker Loader identity, and injects only the scoped `ITX` host.
`src/processors.ts` and `src/egress.ts` are also real, promising pieces. The
former is now integrated: `Context` runs it after commits, arms its retry
alarm, exposes progress through `inspect`, and its five local-network E2Es
cover delivery, pinned repository source, retry/halt, replacement recovery,
and a page beyond 128 events. `Egress` is now integrated too: external fetches
use its terminal, approval decisions apply in the append transaction, and the
write-only `/secrets` route requires the operator bearer token. Three local
network E2Es initially exercised exact approval, tampering, denial, expiry and
replay. The expanded seven-test synthetic fixture now also proves injection,
write-only control/receipts, origin binding, rotation, and safe redirect behavior.
See [current acceptance evidence](../evidence/local-verification.md): rejected
native pipelines and retry-alarm ownership now pass the local suite/stress
without extra cancellations; deployed lifecycle acceptance remains pending.

A small event-backed task board's HTTP shell can therefore be project code:

```ts
export default {
  async fetch() {
    return Response.json({ title: "Tasks", note: "read events through ITX" });
  },
};
```

The fetch worker part exists and has a network E2E in `e2e/core.test.ts`.
Configured workers also receive durable at-least-once `processEvent(event)`
delivery with a persisted cursor, two bounded retries, a 20-second delivery
timeout and visible diagnostic state. This is enough for an idempotent task
projection; it does not give the callback an extra `itx` argument, and it
does not turn an arbitrary side effect into exactly-once work.

The product reference is Docs: `apps/docs/src/rpc-api.ts` maps board/workspace
paths to a project surface; `tasks-rpc-api.ts` is the board lens; and
`packages/workspace-documents` owns CodeMirror collaboration. Its config
bridge (`apps/docs/src/config-bridge.ts`) is ordinary project code which calls
auth, a proxy, KV, and app URL capabilities.

## Path namespace is not workspace content

Keep these two things separate even when they spell similarly:

```ts
// Proposed public API: this is a *namespace address*. It selects the
// document application's state/capabilities, not bytes in a repository.
const note = project.docs.open("/workspaces/review/docs/n.md");

// Proposed workspace API: this is a content file at an immutable revision.
const workspace = project.workspaces.open("/workspaces/review");
const base = await workspace.read({
  path: "docs/n.md",
  revision: "sha256:7b…",
});
await workspace.commit({
  baseRevision: base.revision,
  changes: [{ path: "docs/n.md", text: base.text + "\nnext" }],
});
```

`/workspaces/review/docs/n.md` is the project-local namespace for document
events, collaborators and UI. `docs/n.md` is a relative file name inside that
workspace tree;
`read` says which content revision was observed and `commit` either advances
from that revision or reports a conflict. They need not share a Durable
Object. One named durable store/facet can host `/docs`, hot documents can be
sharded later, or a conditional reducer can host them; the path contract stays
the same. Users need not know placement or supply a public actor ID.

Current core has concrete context names such as `Scope.cd("/workspaces/review")`,
while repository revisions are separately `{ repo, revision }`. This is not a
reason to create a context for each file: the proposed document application
resolves its children within the workspace's state owner.
The proposed `workspace` verbs do not exist yet: they identify the narrow
missing boundary rather than claiming a file API has been built.

## Exact gap matrix

| Need                  | Current evidence                                                                                                                                                                                                  | Userspace answer                                                     | Kernel/product gap                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Task/comment activity | `Stream.commit/readEvents/subscribe`; integrated `Processors` has persisted cursor/retry/halt state and local-network E2Es                                                                                        | Event schemas and idempotent projections                             | One-use approval bounds dispatch attempts, not exactly-once external outcomes; uncertain outcomes need provider idempotency/reconciliation. |
| Live board            | WebSocket page/ack in `src/stream.ts`; attachment survives hibernation                                                                                                                                            | Browser owns its read cursor and re-reads after reconnect            | No server consumer is needed for an ordinary board. Add one only for a durable side effect/projection.                                      |
| Project app host      | `/p/<project>/…` reaches the sole `mount/fetch` policy; `NEXT.to({kind: "worker", source})` supplies a native Fetcher, with a public WebSocket echo proof                                                         | Route by project plus project-local path                             | Slug/domain routing, cookies and membership gate; see `apps/os/src/ingress.ts`.                                                             |
| Proxy, WS, assets     | `Context.fetch()` forwards ordinary fetch; stream/lending have explicit WS upgrades                                                                                                                               | App-relative links and a loaded worker's module-contained response   | An ingress rewrite/proxy must preserve relative URL/query, Upgrade, and auth; static asset hosting is separate from Worker Loader.          |
| CodeMirror collab     | No file/facet API                                                                                                                                                                                                 | Small event document only                                            | Named durable app storage, alarm and compaction semantics; OS references `domains/workspaces/collab-{engine,host,store}.ts`.                |
| Workspace overlay     | Immutable repo snapshots only                                                                                                                                                                                     | App can own a small map                                              | File tree, whiteouts, mounted base revision and blob spill; `workspace-core.ts`.                                                            |
| Repo-backed config    | `{repo,revision}` source exists                                                                                                                                                                                   | Caller can select one                                                | Config activation event, resolved build output and replayable processor installation.                                                       |
| Git remote            | No git/credential boundary                                                                                                                                                                                        | App-owned remote client possible                                     | Egress + write-only secret terminal. Hosted Git is optional; `domains/repos/git-wire.ts` is reference.                                      |
| Human identity        | No caller principal in Scope/event/fetch; signature level is cryptographic verification, not a human session                                                                                                      | Project paths do not require a public actor ID                       | Optional session/API-key verification and platform-stamped actor provenance; `auth/project-auth.ts`.                                        |
| Egress and secrets    | Integrated terminal; seven local E2Es cover encrypted secret injection, write-only control/receipts, origin binding, rotation, redirects and approvals                                                            | Ordinary app fetch enters the gate; control-plane-only secret writes | Establish owner identity and lockdown, then prove deployed acceptance. Write-only access is not response taint tracking.                    |
| Autonomous work       | No user-facing alarm                                                                                                                                                                                              | External cron may append                                             | Named schedule/alarm, or an explicit external scheduler contract.                                                                           |
| Large attachments     | Core: `append` caps one request at 512 KiB and `readEvents` pages at about 256 KiB; repository blobs are SQLite text. Old project-worker chunks event rows at 512 KiB but still caps a serialized event at 8 MiB. | Tiny text files                                                      | Content-addressed blob/R2 primitive, streaming and retention policy.                                                                        |
| Live callbacks        | `src/lending.ts` pages a client capability                                                                                                                                                                        | Good for live RPC                                                    | Not durable app storage or authority.                                                                                                       |

The boundary is the design: document reductions, a task rule, an HTTP UI, a
git client, and a particular approval process are application code. Ordering,
capability confinement, provenance stamping, secret substitution, and atomic
one-use approval consumption cannot be safely delegated to the app that benefits
from bypassing them.

The earlier clean-room worker is materially ahead on one axis: its
`IterateContextDurableObject` hosts named Durable Object facets with their own
storage, and its client package has live-state gap-healing. Core is
intentionally flatter—one context SQL store plus stream, repo, mounted worker
and integrated processor—so it still has no named facet/storage address.
Conversely, core's small surface makes the missing seams easy to name. This
is verified directly in
`packages/v3/project-worker/src/iterate-context-durable-object.ts` and
`packages/v3/project-core/src/{worker,processors}.ts`, not inferred merely
from the older assessment.

Named app storage is the first genuinely blocking primitive for collaborative
apps. A log gives total order, but _not_ the application's acceptance rule.
For example, two editors can both read version 7 and append independently:

```ts
// Both calls succeed and get different offsets. Order alone cannot say whether B
// was based on A's change or must be rejected/rebased.
const before = await itx.document.read("roadmap"); // { version: 7, text: "…" }
await itx.append({
  id: crypto.randomUUID(),
  type: "doc.replace",
  data: {
    path: "roadmap",
    baseVersion: before.version,
    text: "my edit",
  },
});
```

The kernel needs either a named durable facet whose transaction reads and
writes the document version atomically, or a deliberately narrow conditional
append/reducer operation. A minimal latter shape is:

```ts
await itx.documents.apply({ path: "roadmap", expectedVersion: 7, changes });
// -> { ok: true, version: 8 } | { ok: false, current: { version: 8, changes } }
```

That makes conflict/OT/CRDT policy an app-level choice while making the
compare-and-accept invariant platform-enforced.

## Build then execute immutable build output

OS’s build shape is the right inspiration. The detailed contract lives in
`apps/os/docs/dynamic-worker-build-requirements.md`; the implementation is
`domains/workers/{build-backend,worker-build-coordinator,worker-loader}.ts`:

```text
immutable repo revision + build options
  -> content build key -> one coordinator Durable Object -> successful build-output cache
  -> Worker Loader executes exact modules with scoped ITX
```

The coordinator gives each build key one Cloudflare coordination atom. KV only
caches immutable successful results; it is not used as a lock. The OS adapter
also turns source compilation failures into plain data, while infrastructure
faults remain faults, and rejects dependency/install warnings that otherwise
become a confusing first-request Worker Loader crash.

Keep project-core’s public contract much smaller than OS’s broad
`createWorker/createApp` mirror:

```ts
type SourceRef = { repo: string; revision: string; entry: string };
type BuildResult =
  | { ok: true; output: { digest: string; modules: Record<string, string>; entry: string } }
  | { ok: false; kind: "source"; problems: string[] };

await project.code.activate({
  source: { repo: "config", revision: "a2…", entry: "iterate.worker.ts" },
  buildOutputDigest: built.output.digest,
});
```

Activation must verify that the build-output digest was made from the exact repo
revision, builder version, options and compatibility date. The runtime executes
the build output—not `repo@head`. Inline browser-provided source can be a valid
small-app path too, but it must be canonicalized, content-addressed, built,
and then activated by that pinned digest under exactly the same rules. A later
edit makes a new digest/build key/activation event. The current
`src/runtime.ts` does only the final Loader step: it computes a stable loader
identity for the narrow `Source` adapter and lets Worker Loader cache isolates.
The optional builder is now implemented separately:

```ts
const result = await project.build.build({
  source: { repo: "config", revision },
  options: { entryPoint: "iterate.worker.ts" },
});
if (result.status === "built") {
  using worker = await project.load(result.code);
}
```

It resolves immutable repo files and caches code by resolved bytes, options
and deployed compiler version in KV. It does not yet typecheck, install
registry dependencies, activate the output as a processor, or record which
build handled an event. The `code.activate()` example above remains a design,
not today's API. See [the exact build contract](typed-surface-and-builds.md).

## Typecheck is assistance, not authorization

`apps/os/src/domains/typecheck/virtual-project.ts` synthesizes a virtual
TypeScript project from the capability surface. The capability-host script
runner checks `async (itx) => { … }`, but runtime execution still receives a
real scoped capability and applies its limits. Project code should use the
same split. The following is a proposed generated declaration for the full
path-oriented surface; the current processor callback remains
`processEvent(event)`:

```ts
declare const itx: ProjectItx; // generated from the public project interface

export async function processEvent(event: Event) {
  if (event.type === "task.created") {
    await itx.at("/tasks").workspace.commit({
      baseRevision: "sha256:7b…",
      changes: [{ path: "tasks/index.json", text: "…" }],
    });
  }
}
```

```ts
const checked = await build.typecheck({ source, declaration: projectItxDts });
if (!checked.ok) return checked.problems;
const built = await build.compile({ source, revision, options });
await project.code.activate({ source, buildOutputDigest: built.output.digest });
```

TypeScript catches `itx.secrets.read()` when the generated declaration has no
such method. It does not stop `any`, stale declarations, JavaScript, a
malicious build output, or a new URL. Runtime capability confinement and the
egress gate—not types or a signature level—decide whether a request can leave
the project, use a secret placeholder, or consume an approval.

## Minimal layers and required proof

1. Make config activation a signed event naming an immutable repo revision.
2. Extend the implemented build adapter with a durable activation receipt;
   use OS’s coordinator shape only when builds are expensive/networked.
3. Keep the integrated one-argument `processEvent(event)` contract narrow and
   prove its eviction/retry behavior in deployed network E2E. Add a separate
   scoped capability argument only if a processor has a concrete need for it.
4. Add ingress identity and platform-owned actor provenance.
5. Prove the integrated egress terminal and exact approval consumption on a
   deployment, including origin-pinned secret injection and uncertain outcomes.
6. Add named durable app storage plus alarms only when Docs collaboration needs
   it; do not hide a generic facet system in the first processor.

Current tests prove a dynamic worker mount, immutable repo commit, stream page,
provenance envelope, and five processor cases (delivery, pinned repo source,
bounded failure, replacement recovery, and pagination) in local-network E2E
(`e2e/{core,provenance,processors}.test.ts`). Seven additional local-network
egress tests cover the integrated terminal, synthetic secret injection and
redirect restrictions (`e2e/egress.test.ts`). The two public-network build tests
also prove pinned TypeScript bundling, cache reuse/options invalidation,
structured rejection, and reloading cached code with a different context's
ITX. They do not yet prove compiler-version invalidation across deployments,
activation identity, ingress identity, blobs, workspace revision conflict
handling, or collaboration. The local runtime-lifecycle checks are now green
within the [documented scope](../evidence/local-verification.md), including a
separate graceful process-restart probe; deployed lifecycle proof is pending.
These capabilities need deployed network E2Es before this is called a Docs-class
userspace platform.
