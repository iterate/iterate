---
state: todo
priority: medium
size: large
tags: [os, repos, workspaces, architecture, performance]
---

# Lazy per-object repo reads via Cloudflare Artifacts REST

Follow-up to the workspace-mounts flag day (PR #2095). That PR gave every
repo a **durable head-tree cache** inside its own `RepoDurableObject` (main
materialized into DO SQLite + R2 spill, invalidated by the local head
cursor), so HEAD reads are clone-free in steady state. Two limits remain,
both inherent to whole-tree materialization:

1. **The isolate memory ceiling caps repo size.** Materialization still runs
   one full isomorphic-git clone through the DO (a ~21MB pack inflates to
   ~290MB in-memory), so repos past that ceiling cannot be cached — or read
   at HEAD — at all.
2. **Storage cost is whole-tree per repo**, even when only a handful of files
   are ever read.

## The successor: read objects, never trees

Cloudflare Artifacts (already our repo backend — the `artifacts.cloudflare.net`
remote) exposes per-object REST reads:

- `GET /repos/:name/blob/:hash` — raw blob bytes
- `GET /repos/:name/tree/:hash` — one tree object
- `GET /repos/:name/file?ref=&path=` — resolve+read in one call
- `GET /repos/:name/commit/:hash`, `/log`

Because trees and blobs are immutable and keyed by oid, a read-through cache
never invalidates: after a head move only the changed trees are refetched,
and blobs only when someone actually reads them. `readFile` costs a tree walk
over cached manifests plus at most one blob fetch; `listFiles`/glob cost tree
objects only. No whole tree ever transits the isolate — repo size becomes
unbounded for the read path.

## Plan

1. **Probe first (decision gate).** Verify our account/token can call the
   REST read endpoints (they are documented under the closed beta; we only
   exercise the git smart-HTTP surface today). Establish which auth works
   (repo-scoped tokens from `gitAccess()` vs account API token) and measure
   per-object latency. If REST is gated for our tier, this task waits — there
   is no isolate-side fallback (isomorphic-git cannot do filtered fetches).
2. **Read-through layer in the Repo DO**: oid-keyed tree manifests in DO
   SQLite (cache forever), blob LRU with R2 spill past the inline threshold,
   `readFileAt(commitOid, path)` / `listAt(commitOid, prefix)` backing the
   existing `readFile`/`listFiles`/`listTaskFiles` surface. The durable
   head-tree cache remains as the hot tier for small repos (the task board's
   fan-out globs should not become per-file REST calls); large repos skip
   materialization entirely and go lazy.
3. **Blob-storm guard**: read-everything operations (a workspace `glob` with
   `{ contents }`, future search indexing) must batch or bound blob fetches —
   the rate limit is 2,000 req/10s per artifact, so the tree/manifest cache
   is mandatory, not optional.
4. **Workspace mounts inherit it for free**: mounted fall-through reads
   already route through `RepoDurableObject.readFile`, so once the repo DO
   reads lazily, arbitrarily large repos become mountable (`read-only`
   policy) with no workspace-side change. Per-mount pinned base oids (and an
   explicit `sync` with conflict reporting) become natural here, since every
   read is keyed by commit oid anyway.

## Acceptance

- A repo larger than the isolate ceiling can be created/imported and served:
  `readFile`/`listFiles`/`listTaskFiles` at HEAD work without any full clone
  or materialization.
- Steady-state reads issue zero Artifacts requests for unchanged oids.
- The existing head-tree cache still serves small/hot repos unchanged.
- Rate-limit safety demonstrated under a fan-out read (task board on a big
  repo).
