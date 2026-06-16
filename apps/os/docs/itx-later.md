# itx, later

Horizon design — eventualities we are deliberately shaping the data
structures for WITHOUT building yet. Separate from itx-next.md (the
current arc's working notes) on purpose. Sibling reading:
itx-authority-research.md (the principal/authority report).

## SELF-DESCRIPTION IS A LOAD-BEARING REQUIREMENT (everywhere, loudly)

**Agents are a first-class audience of this system, and an agent's only
sense organ is `describe()`.** The acceptance test for every feature in
this document: _an agent with no prior knowledge, handed a stub, can act
competently from `describe()` + `instructions` + `types` alone._ This
must be designed for, not hoped for:

- Every provide carries `instructions` (human/agent prose) and `types`
  (machine/editor declarations) AT provide time — the provider knows the
  surface best at exactly that moment; the platform defaults are the
  exemplars.
- Every fold is a description: the capability table (what can I do
  here), the `http` subtree (what routes/apps does this project serve —
  describe() on a project automatically reveals its routes), the repo
  processor's workers table (what apps does this project have), stream
  state, context journals (what happened).
- Every domain object answers describe(): contexts, workers, repos,
  routes, agents and their sessions.
- When adding any new capability, route, worker, or event type, the
  review question is: "what does describe() say about this, and is that
  enough for an agent to use it?" If the answer is weak, the feature is
  not done.

## One source address — the repo IS the artifact wrapper

Owner review resolved the apparent artifact-vs-repo split: they are not
two address kinds. There is ONE addressed source form, and the build
output is a CACHE, not an address:

```ts
type WorkerSource =
  | { type: "inline"; modules: Record<string, string>; mainModule: string }
  | { type: "repo"; repo: string; commit: string | "latest"; path: string; bundle?: BundleOptions }; // bundle absent → the path IS the module(s)
// shared envelope: entrypoint?, exportType?, compatibilityDate?
```

- **The built output is the checkpoint of the build-fold.** `build(repo@
commit, path, bundleConfig) → modules` is a pure function; its output
  is a memo cache, never an address. Terminology corrected on review:
  in this stack a Cloudflare ARTIFACT IS A HOSTED GIT REPO (the repos
  domain's backing — `cf.artifacts.repo.*`), NOT a blob store. The memo
  cache is an **R2 bucket of hash-keyed immutable bundles**
  (`hash(repo, sha, path, bundleConfig)` → built modules + a sibling
  meta.json) — the canonical build-cache shape (Nix store, Bazel CAS,
  Turborepo remote cache). R2's read-after-write consistency makes a
  provide-time build immediately dialable; eviction is free (TTL/LRU)
  because every entry is reproducible from its key. Three tiers, one
  key: repo (authority) → R2 (memo) → loader isolate cache (ephemeral).
  Builds run at provide time (pinned commits) and push time
  ("latest" pre-warm); dial-time build is the cold-miss fallback,
  serialized so concurrent dials don't stampede — per COMMIT, where
  today's project worker rebuilds per CALL.
- **The cache key is the address**: `(repo, commit, path, bundleConfig)`.
  The caller-supplied `cacheKey` footgun exists only for `inline`
  (where a content hash can derive it too). `"latest"` resolves to a
  sha at dial and caches by the sha.
- **Bundling happens at provide/build time, never dial time**
  (@cloudflare/worker-bundler or the existing project build pipeline):
  determinism, bounded first-call latency, and the journal records
  input → output so every capability's exact bytes are recoverable.
- **dist-in-git is a supported convention, not a mandate**: a repo may
  check in its built output and point `path` at it (bundle step =
  identity; maximum debuggability — one commit addresses source AND
  bytes). Cost is repo size/churn; fine for small project workers, wrong
  for big apps; per-repo choice, same address form either way.

## The project repo is the only special thing

With repo-sourced capabilities, the project worker stops existing as a
concept. The platform guarantees exactly one thing: **every project has
its config repo, with a defined file structure.** The `worker` default
becomes an ordinary provide:

```ts
{ path: "worker",
  capability: { type: "rpc", worker: { type: "source",
    source: { type: "repo", repo: "iterate-config", commit: "latest", path: "worker.ts",
              bundle: { … } } } } }
```

The ProjectWorker forwarder dissolves (the dial's own source case covers
it); pinned-commit provides give reproducible capabilities (the journal
entry fully determines behavior); `"latest"` is reserved for defaults
that should track pushes.

## Stateful source capabilities: the context DO is the runner

Dynamic-worker DurableObject classes cannot be durable on their own —
they need a real DO to host them as facets (Cloudflare's AppRunner
supervisor pattern; the dial already does exactly this:
`facets("cap:" + name, () => ({ class: loadWorker(...).getDurableObjectClass(entrypoint) }))`,
keyed by the HOST context so data survives code upgrades). In the final
shape the runner is therefore **the context's own DO** — ItxDurableObject
for plain contexts, the rich host for agents: a context's stateful
capabilities live as facets inside the same DO that holds its journal
fold, and are deleted with it. No separate runner class exists.

## Materialization is the third, independent dimension

What the modules ARE (the source address) / how they RUN (dynamic
worker loader today; Workers for Platforms dispatch namespaces later) /
how they are CALLED (entrypoint + call({path, args})) vary
independently. Addresses pin only the first, so the runtime swap, when
it comes, is invisible — the same host-swap property context addresses
bought.

## Bundling without the workspace (owner decision)

The workspace object plays NO role in building. The repos domain already
exposes `readFiles`/`listFiles` on the repo DO and the bundler runs on an
in-memory vfs, so the whole path is: repo DO `readFiles(commit)` →
@cloudflare/worker-bundler vfs → esbuild-wasm → R2 memo. No clone, no
shell, no filesystem. Requires a new R2 bucket resource + binding
(`ITX_BUILD_CACHE`) in alchemy.run.ts. No backcompat with the old
checkout pipeline — `workerHost`/checkout storage dies with it.

## The "no longer special" checklist for the project worker

- ProjectWorker forwarder + itxProjectWorkerCall + its mask entry: deleted
  (the dial's ordinary `source` case covers repo sources).
- workerHost build machinery in the Project DO (build chains, checkout
  keys, background rebuilds, ready flags): deleted — building is the
  generic repo→R2 memo, owned by no DO.
- Rebuilt per CALL with worker.ts verbatim → built per COMMIT, really
  bundled (TS, multi-file, deps), pinnable.
- `worker` = one ordinary provide:
  `{ type: "repo", repo: "iterate-config", commit: "latest", path: "worker.ts", bundle: {…} }`.
- The platform guarantee shrinks to: THE PROJECT REPO EXISTS with a
  defined file structure. Done = `grep ProjectWorker` returns only the
  default-provide line's prose.

## Ingress: the hostname edge is the realm's HTTP restorer

A URL is a ref form; ingress is one function:
`(hostname, path, credential) → (context address, capability path) →
invoke({ path: […, "fetch"], args: [request] })`.

- **Derived URLs, not a routing table**: a context's hostname is a
  projection of its id (`ctx-abc123.prj-myproj.iterate.app`), derivable
  both directions, zero rows; claimed/custom hostnames remain the one
  genuine table. Anything with an address that answers `fetch` is
  browsable — including a script's dynamic worker — with no machinery.
- The pieces exist (ItxCapabilityIngress + meta.http.expose/public,
  share-token sealed refs, /api/itx/:ref connect); the work is unifying
  them into the one edge function over derived names.
- Auth at the edge: public is per-capability opt-in; share tokens are
  the bearer bridge; everything else is cookie → principal → mask (see
  itx-authority-research.md).

## Workers: ephemeral or durable — LOCKED

**Dynamic workers are either ephemeral or durable. Ephemeral workers
(inline provides, script runs) have no identity, no journal, no record —
by design. Durable workers are ALWAYS associated with a repo, and their
entire life is events in the REPO's stream, folded by the repo
processor.** (Owner lock, 2026-06-11 night.)

- Identity: declared in the repo manifest (`iterate.toml` at a fixed
  root path — the platform's one well-known bootstrap name), `(repo,
name)`, NEVER path-derived: the runner DO key, facet storage, and
  routes hang off the name; source bindings `(commit, path, entrypoint,
bundleConfig)` are rebindable attributes recorded per build event.
  Monorepos: many workers per repo, each a manifest entry. The same
  rule recurses to durable-object classes: the manifest declares stable
  facet names; export names are rebindable.
- Journal: the repo's stream carries worker-created (birth certificate
  in the PARENT's journal — right for an object that cannot outlive its
  parent), worker-built {sha, r2Key}, route-bound, worker-removed. The
  repo processor's fold is the workers table. Lifecycle is LAZY: a
  Worker materializes on first reference; the manifest is the
  build-time name→entry lookup.
- Runner: the repo DO hosts durable worker facets initially, addressed
  by door paths ({binding: "REPO", name, path: ["workers", "api", …]});
  a hot worker shards to its own runner later as a host swap under an
  unchanged name.
- Stateful SOURCE CAPABILITIES (provided by a context, die with it)
  remain facets of the context host; itx ADDRESSES workers, never hosts
  them. Workers for Platforms remains the eventual materialization swap.

## HTTP: the routing table IS the capability fold (stolen + attacked, v1 scoped)

Two concerns, split: **reachability** (may this capability serve HTTP,
to whom) lives in the provide (`meta.http: { public?: boolean }`);
**naming** (at which URL) is a BINDING owned by the namespace owner.

- **Derived tier (free, total)**: `{door}--{slug}.iterate.app` + the
  context's stream coordinate as the URL path:
  `https://itx--misha.iterate.app/agents/support/itx/itx_a1b2/preview`.
  The `--` separator is forced by TLS, not taste: wildcard certs cover
  ONE level (`*.iterate.app` covers `itx--misha.iterate.app`, never
  `itx.misha.iterate.app`). provideCapability returns the derived `url`
  on its handle. Context id prefix renames ctx* → itx* (punch list).
- **Bound tier**: a route IS a provide at the reserved `http` subtree:
  `provideCapability({ path: ["http", "blah.example.com"], capability })`;
  ingress = `invoke(["http", host, "fetch"], [request])` on the project.
  Free consequences: journal = route history, describe lists routes,
  revoke unbinds, and the Capability union means a route can target a
  LIVE provider — one-line ngrok, auto-unbinding with the session. The
  root convention (`misha.iterate.app` → the worker capability's fetch)
  becomes an ordinary, shadowable platform-default route — the last
  project-worker specialness dissolves.
- **The attack, priced**: (1) longest-prefix cannot express wildcard
  hosts / path-prefix / method rules — v1 is EXACT-HOST ONLY, with the
  escape hatch that routing may graduate to its own processor folding
  the SAME journal entries (only the fold changes); (2) host binding is
  an authority question — the edge validates provides under the `http`
  subtree (the one special-cased subtree, priced as such); (3) hosts
  contain dots → array-form paths only for this subtree; (4) per-request
  DO routing eventually wants the KV cache, mediating the fold-is-table
  purity.

## Naming the special repo

It is what makes one iterate project different from another. Candidates
reviewed: `project` (recommended — "the project repo", meaning
strengthens as the repo becomes the project's codebase), `main`
(collides with branch vocabulary), `config` (decays as workers/apps move
in). Awaiting owner pick; rename lands with the repo-source wave.
