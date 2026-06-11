# itx, later

Horizon design — eventualities we are deliberately shaping the data
structures for WITHOUT building yet. Separate from itx-next.md (the
current arc's working notes) on purpose. Sibling reading:
itx-authority-research.md (the principal/authority report).

## One source address — the repo IS the artifact wrapper

Owner review resolved the apparent artifact-vs-repo split: they are not
two address kinds. There is ONE addressed source form, and the build
output is a CACHE, not an address:

```ts
type WorkerSource =
  | { type: "inline"; modules: Record<string, string>; mainModule: string }
  | { type: "repo"; repo: string; commit: string | "latest"; path: string;
      bundle?: BundleOptions }   // bundle absent → the path IS the module(s)
// shared envelope: entrypoint?, exportType?, compatibilityDate?
```

- **The built output is the checkpoint of the build-fold.** `build(repo@
  commit, path, bundleConfig) → modules` is a pure function; its output
  is stored content-addressed BY ITS INPUT TUPLE (CF Artifacts is the
  store), rebuildable at will, never addressed directly. Same doctrine
  as processor checkpoints: the stream/repo is the authority, the
  derived bytes are disposable cache. ("Why are artifact and repo
  separate?" — they aren't; artifact is the memo table.)
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
  bytes). Cost is repo size/churn; fine for small config workers, wrong
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
