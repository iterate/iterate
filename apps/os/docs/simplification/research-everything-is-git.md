# Research: "What if everything is one Git repo?"

_Feasibility check for the radical-simplification idea that a project's entire
durable state — events, attachments (via Git LFS), the search index — collapses
into a single Git repo, with ephemeral events not persisted at all. Real system
names and real numbers throughout. Written to be argued with; the verdict at the
end is decisive._

Grounding note: iterate's current design already separates **small events that
reference bigger durable objects** ([[D9]], `DESIGN.md:421`) — an event carries a
commit hash or a content-addressed blob reference that resolves out-of-band. The
current stores are: **event streams** (DO-SQLite journals), a **git repo** (code
/ genome, on the Artifacts git remote), **R2 blob buckets** (files/workspaces,
mutable, `project-files.ts`), and an **AI/Vectorize search index** (derived).
This document assesses collapsing all four into one.

---

## 1. The largest Git repos in the world, and what breaks first

### Real numbers

**Microsoft Windows** — the canonical "largest Git repo on the planet"
(devblogs.microsoft.com/bharry):

- **~300 GB** on disk, **~3.5M files** in the working tree.
- **~250,000 reachable commits** over **4 months** of history.
- **4,352 active topic branches**; **8,421 pushes/day**; 1,760 builds/day.
- Vanilla Git was unusable: `clone` took **12+ hours**, `checkout` **2–3
  hours**, `status` **~10 minutes**. Many commands "would never complete."
- This only works at all on **VFS for Git / GVFS** (virtual filesystem that
  lazily hydrates files on access) — later generalized into **Scalar** (partial
  clone + sparse checkout + background maintenance + commit-graph), which
  Microsoft now recommends over GVFS. With GVFS: clone dropped to **~127 s**
  (Redmond, 80th pct), status to **~5 s**.

**Chromium** — plausibly the largest _public_ Git repo; **>36M SLOC**, tens of
GB of history, heavy use of partial clone. **Linux kernel** — the commit-count
champion of ordinary repos: crossed **1,000,000 commits in 2021**, ~888k commits
and 27.8M lines by end-2019, ~21k authors. On-disk history is only a few GB
because the kernel is text.

### The takeaway that dominates everything below

The single largest, best-funded, most-engineered Git repo on Earth has
**~250k commits per 4 months** and needed a **custom virtual filesystem** to be
usable. iterate is contemplating **billions of events** (§2). These are not the
same order of magnitude; they are not even the same _universe_ of magnitude.

### What breaks first, in order

Git degrades along several independent axes. The one that bites depends on your
workload; for a commit-per-event workload the ordering is roughly:

| Axis                       | Where it hurts                                                                      | Real threshold / evidence                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Commit count**           | fetch negotiation, `git log`/topo-sort, `gc`/repack graph walks, commit-graph write | See §2 — this is iterate's binding constraint                                                                                                                                     |
| **Ref count**              | `ls-remote`, fetch advertisement, `packed-refs` scans                               | 144k refs / 12 MiB packed-refs → iterating all refs took **>2500 s**; loose-ref-per-branch wastes inodes; reftable recommended at "tens of thousands" of refs (gitperf.com ch.17) |
| **Total repo size**        | clone/fetch time, disk, memory to hold packs                                        | GitHub recommends **<1 GB**, strongly **<5 GB**; Azure Repos soft-recommends **<10 GB**, **hard limit 250 GB**                                                                    |
| **File count / dir width** | `status`, checkout, index size                                                      | Windows needed GVFS at 3.5M files; ≤3,000 entries/dir recommended                                                                                                                 |
| **Individual file size**   | push rejection, memory                                                              | GitHub warns >50 MiB, blocks >100 MiB; that's what LFS is for (§3)                                                                                                                |
| **Packfile size**          | memory pressure during repack                                                       | No hard limit but Git "becomes sluggish when packfiles don't fit nicely in memory"                                                                                                |
| **Repack time**            | maintenance windows, CI                                                             | GitHub's old "repack the whole repo into one pack" was **quadratic** and hit timeouts; geometric repacking fixed it (§2)                                                          |

**Bottom line for §1:** Git scales _superbly_ for gigabytes and hundreds of
thousands of commits **of code**. It does so only with modern machinery
(commit-graph, MIDX, geometric repack, partial clone, reftable) and, past a
certain size, a virtual filesystem. Nothing about that machinery was designed
for, or has been proven at, the commit counts §2 requires.

---

## 2. Commit-per-event at billions: feasible?

### The core problem

iterate will have **billions of events in production** (Jonas's number). A
naïve "one Git commit per event" means a repo with **billions of commits**. No
such repo exists anywhere. The record-holder for _ordinary_ repos is the Linux
kernel at ~1M commits — **three to four orders of magnitude short** of a billion.

### What degrades, concretely

Every core Git operation has a cost that is at least linear (often
super-linear before the commit-graph) in commit count:

- **Commit-graph** is the mitigation that makes commit-count survivable at all:
  it precomputes generation numbers + optional changed-path Bloom filters,
  giving **50–100× faster** history traversal, **100–200×** with generation-number
  pruning, **10–20×** on ahead/behind checks (Azure DevOps blog). But the
  commit-graph file _itself_ must be written and rewritten; it stores per-commit
  metadata (OID, root tree, dates, parent positions, generation number). At a
  billion commits that file is tens of GB and its (re)generation is a full walk.
- **Fetch negotiation** advertises "have" lines and walks history to find common
  ancestors. Git 2.55 had to add `fetch.negotiation` include/restrict controls
  precisely because negotiation misbehaves in repos with many refs/commits. At a
  billion commits, negotiation is pathological.
- **`gc` / repack** walks the object graph. GitHub's own maintenance "began
  hitting our self-imposed timeouts on larger repositories" with the old
  full-repo repack, which grew **quadratically**. Their fix — **geometric
  repacking + multi-pack-index (MIDX) + reachability bitmaps** — makes repack
  cost scale with _new_ objects, not total, dropping average repack from **~60 s
  to ~15 s** and saving **5.67 CPU-days/hour** fleet-wide. That is the state of
  the art, and it is about making a **code repo's** maintenance tractable — not a
  billion-commit event log.
- **`fsck`** is a full-graph integrity walk: O(objects). Unbounded at this scale.
- **Object count / loose objects**: one commit per event also mints a tree and
  often a blob per event → billions of objects. Loose-object explosion alone
  kills the filesystem (inode pressure, `readdir` on `.git/objects/xx/`).

### Prior art for "millions/billions of commits"?

**None exists.** There is no public or private Git repo in the millions-of-
commits range, let alone billions. The versioned-data systems that _do_ reach
billions of records (Dolt, Irmin/Tezos, Noms) explicitly **do NOT use one commit
per record** — that is the entire point of §4. They keep a Git-_style_ commit
graph that is short (thousands–millions of commits) and push the billions of
records _inside the tree structure_ of a single commit.

### Realistic ceiling and mitigations

- **Ceiling for one-commit-per-event: low millions of commits**, and only with
  commit-graph + partial clone + aggressive maintenance, and even then history
  operations get slow. Billions is not on the table.
- **Batching many events per commit** is the obvious mitigation: commit every N
  events or every T seconds. This trades commit count for _latency_ and
  _granularity_ (you lose per-event addressability by commit) and reintroduces a
  buffer that must live _somewhere durable before the commit_ — which is exactly
  the append-only stream you were trying to delete. It shrinks the problem but
  does not make Git an event log; it makes Git a periodic snapshot of an event
  log that lives elsewhere.
- **Shallow / partial clone** (`--filter=blob:none`, `--depth`) helps _readers_
  but does nothing for the write/maintenance side, and it means clones no longer
  have full history — antithetical to "the repo IS the durable memory."
- **Commit-graph** is mandatory but is a read accelerator, not a write-scale fix.

**Verdict preview:** commit-per-event at billions is **not feasible**. It fails
on write throughput, object/commit count, and maintenance cost simultaneously,
and there is zero prior art suggesting otherwise.

---

## 3. Git LFS: mechanics, limits, and suitability for attachments

### How it works

Git LFS replaces each tracked large file with a small **pointer file** committed
into Git (~130 bytes): it records the LFS **version**, the object **OID**
(sha256), and the **size**. The actual bytes live on a **separate LFS server**
(an object store behind an HTTP API), _not_ in the Git object database. On
checkout, a **smudge** filter swaps the pointer for the real bytes, fetched
lazily; on commit, a **clean** filter swaps bytes for a pointer. Clones fetch
only the LFS objects reachable from the checked-out commit ("lazy pull"), not all
history.

### Real limits (hosted)

- **Per-file cap**: GitHub LFS rejects files **>5 GB** (Enterprise; 2 GB free/pro
  tiers historically). GitLab LFS: 100 MB/file default hosted.
- **Bandwidth/storage quotas**: LFS is metered separately and provider-specific;
  exceeding quota **restricts access** (you can't pull your own bytes).
- **Two stores, two failure modes**: pointer-in-git vs bytes-in-LFS can
  desynchronize.

### Operational pain points (the "LFS nightmare" class)

- **Missing client**: a collaborator (or CI, or an agent runtime) without
  `git-lfs` installed gets the **130-byte pointer instead of the file** — silent
  and confusing.
- **Smudge errors**: LFS can't reconstitute a file (auth expired, object missing
  on server) → checkout half-broken while plain Git commands look fine.
- **Auth drift**: an expired LFS token breaks LFS while normal Git keeps working
  — a maddening split-brain.
- **History rewrites** are brutal: migrating existing large files into LFS
  rewrites history; un-migrating is worse.
- **Migration is one-way-ish and viral** across every clone.

### Partial clone / sparse checkout / Scalar as the "modern" alternative

Git's own **partial clone** (`--filter=blob:none`, `blob:limit=N`) + **sparse
checkout** now do much of what LFS and GVFS did, without a second protocol:
blobs are fetched on demand from the _same_ remote; the working tree is
restricted to a cone of paths. **Scalar** bundles partial clone + sparse
checkout + background maintenance + commit-graph and is Microsoft's recommended
path for large repos post-GVFS. For iterate this matters: if you're in the
Cloudflare/Artifacts-git world, you likely can't run an LFS server _or_ a
GVFS/Scalar cache server as first-class infra without building it.

### Suitability for iterate's attachments

Attachments in iterate are already **mutable R2 objects with a content hash**
([[D9]], `project-files.ts`) and events already carry the _pointer_. Git LFS
would give you: (a) a pointer file (you already have a content-hash pointer as a
_fact_), (b) a separate blob store (you already have R2), (c) an extra protocol,
extra client dependency, extra auth surface, extra quota, and a smudge/clean
filter running inside every agent runtime and CI job. **It reinvents R2-plus-a-
content-hash-pointer, worse.** The only thing LFS adds over "R2 + content-hash
fact" is _version history of the blob keyed to commits_ — which iterate can get
more cheaply by making the pointer an immutable content-addressed fact and never
deleting the R2 object (or tombstoning on retention).

---

## 4. "Git as a database" prior art — and how the ones that scale actually work

The critical finding: **every system that reaches billions of versioned records
abandons one-commit-per-record.** They keep a Git-_shaped_ commit graph
(cheap, short) and put the records inside a **content-addressed, chunked,
structurally-shared tree** — a _prolly tree_ or equivalent Merkle structure.

### Dolt — "Git for data" / versioned SQL (the strongest scaler)

- MySQL-compatible SQL database with real Git semantics: branch, merge, diff,
  clone, push, pull of **schema + data**.
- Built on **prolly trees** (probabilistic B-trees): content-addressed,
  immutable B-trees where node boundaries are chosen by a **rolling hash**
  (content-defined chunking, inherited from Noms — **~4 KB average chunk**,
  64-byte window; a 1-bit change moves a boundary only ~1.6% of the time).
- **Structural sharing**: a write builds a "new" tree but **reuses every node
  outside the changed window** by content address. A commit that changes one row
  in a billion-row table writes ~log(N) new nodes, not N. Diff is **proportional
  to the size of the difference**, computed by comparing content addresses down
  the tree.
- **History independence**: identical data → identical tree → identical hash,
  regardless of insertion order → perfect dedup and cheap merge.
- Storage engine is the **Noms Block Store (NBS)**: content-addressed chunks in
  table files, backed by filesystem or S3; GC by reachability.
- **This scales to millions of versions/branches and (with the B-tree side)
  large row counts** — because the _commit graph_ stays small while the _data_
  lives in a shared Merkle tree. **Dolt does not commit once per row.**

### Noms (Attic Labs) — the ancestor

- The decentralized, versioned, content-addressed database that **invented
  prolly trees**. All previous versions retained; any two versions diffable;
  every chunk stored once, shared by reference. Backends: filesystem or **S3**.
- Unmaintained now; **Dolt is its living fork.** The idea, not the product,
  is what matters: model a large mutable collection as a content-defined-chunked
  Merkle search tree, not as commits.

### Irmin — Git-like distributed DB (powers Tezos)

- OCaml library "following the same design principles as Git": branch, snapshot,
  revert, audit, with pluggable storage. **Tezos stores the entire blockchain
  ledger state as a Merkle tree via Irmin** (`irmin-pack`).
- Same lesson: the ledger is a **Merkle tree whose nodes are content-addressed
  and structurally shared across block-heights**, not a commit per transaction.
  Irmin explicitly moved _off_ `irmin-git` onto `irmin-pack` for scale.

### git-annex

- Manages large files _with_ Git: the file's **content is a symlink to a
  content-addressed key**; only the key (not the bytes) is in Git; bytes live in
  configurable "special remotes" (S3, rsync, etc.). It's the "manifest, not
  blobs" pattern (§5) implemented on top of Git — closest philosophical cousin to
  what iterate already does with R2 + content-hash facts. It scales files well
  but is _not_ a record database and does not address the billions-of-commits
  problem.

### ProllyTree / Merkle-CRDT family (Dolt-descendant, Bluesky, etc.)

- Prolly trees have become the standard structure for "versioned, diffable,
  syncable, content-addressed" data (Bluesky's atproto MST is a cousin). All
  share the same core move: **content-defined chunking + structural sharing** so
  the cost of a change is O(log N), and history/versioning is free because
  unchanged subtrees are shared by hash.

### The one-sentence synthesis of §4

> The systems that scale versioned data to billions of records keep a **short**
> Git-style commit graph over a **content-addressed, chunked, structurally-shared
> Merkle tree**. They win by making a "version" a new _root hash_ over a tree
> that shares 99.99% of its nodes with the previous version — **never** by minting
> a commit per record.

This is the decisive counter to "one commit per event": the prior art that
_looks_ like "Git as a database" is precisely the prior art that _refused_ to
commit per record.

---

## 5. The pragmatic hybrid: Git commits references/manifests, R2 holds bytes

Jonas's floated middle path: the Git repo commits **durable references
(content hashes)** to R2 objects and external resources — a **manifest**, not a
blob store. Assess.

### This is already how iterate is designed

- [[D9]] is exactly this: "**Events are small and reference bigger durable
  objects** … a commit hash or a file-object reference that resolves out-of-band"
  (`DESIGN.md:421`). Bytes stay out of journals (a put would blow the 1 MB
  delivery frame — `subscriber-math.ts:42`); the **pointer is the fact**.
- The ruminations doc already prescribes the manifest shape: journal facts carry
  **content hashes** (`/blobs/sha256/ab/cd…`), bytes live in the **R2 blob
  plane**, retention may later delete the blob while **preserving a tombstone +
  content hash** (`simplification-ruminations-2026-07.md:3879–3907, 4289–4299`).
- The `lens-content-addressed.md` document independently concludes the same
  thing from the code: iterate **already** content-addresses builds
  (`build-key.ts`, `repoContentHash()`), resolves a mutable branch name to an
  immutable content hash (`resolveFileSource`, `worker-loader.ts`), and stores
  artifacts content-addressed with GC-by-TTL (`artifact-store.ts`). Its verdict:
  content-address the **lock and the artifacts** (already ~60% done), keep the
  **authoring surface files-and-git**, and **never make the human/agent edit
  hashes** — because Git won by _hiding_ the hashing (Unison/Nix/IPFS are the
  graveyard of systems that exposed it).

### Is "git holds a content-addressed manifest; R2 holds bytes; search is

derived" the sweet spot?

**Yes — and it is essentially git-annex's and Dolt-NBS's proven pattern.**
The manifest-in-Git-pointing-at-a-content-addressed-blob-store is exactly what
git-annex does (symlink to a key; bytes in a special remote) and what Dolt's NBS
does (chunk references; bytes in table files on S3). It is a well-trodden,
scaling-proven shape. It keeps Git's job _small_ (pointers, code, structure) and
lets the byte-heavy, high-cardinality data live in a store built for it (R2).

The important caveats:

- **The manifest still must not be a commit-per-event.** A manifest that appends
  one commit per file-put still hits §2. The manifest should be updated in
  batches, or — better — the manifest is a **prolly-tree-shaped structure** whose
  root is periodically committed, or the manifest lives in the **stream journal**
  (which iterate already has) and Git commits only the _code/genome_ plus
  periodic snapshots. Git as "a manifest of the code and a periodic checkpoint of
  pointers" is fine; Git as "the live append log of every pointer" is §2 again.
- **The search index should be derived, not stored** — see §6c.

---

## 6. Feasibility verdict for iterate

**## Feasibility verdict for iterate**

**(a) Commit-per-event at billions — NOT feasible. Decisively no.** The largest,
most-engineered Git repo on Earth (Windows: ~300 GB, 3.5M files) has **~250k
commits in 4 months** and needs a **virtual filesystem** to be usable; the
commit-count champion (Linux) crossed **1M commits in 2021**. Billions of commits
is **three-to-four orders of magnitude beyond anything Git has ever done**, and
it fails on multiple axes at once — commit-graph write cost, fetch negotiation,
`gc`/repack (even GitHub's geometric-repack + MIDX state of the art only makes a
_code_ repo's maintenance tractable), `fsck`, and raw object/loose-object
explosion (a tree + often a blob per event = billions of objects). **There is no
prior art** for millions—let alone billions—of commits, and the "Git as a
database" systems that _do_ reach billions of records (Dolt, Irmin/Tezos, Noms)
**explicitly refuse one-commit-per-record**: they keep a short commit graph over
a content-addressed, chunked, structurally-shared **prolly tree**, so a version
is a new root hash over a tree that shares ~all its nodes with the prior version.
Batching events-per-commit shrinks the problem but only by reintroducing a
durable append log _before_ the commit — i.e. exactly the event stream you were
trying to delete. **Keep the append-only event streams. Do not persist events as
Git commits. Do not stop persisting durable events at all** — "don't persist
ephemeral events" is already handled by iterate's explicit delivery/durability
dimensions ([[D11]]), which is the right knob; deleting durable events is a
different and unsafe claim.

**(b) Git LFS for attachments — No.** LFS is "a pointer file in Git + bytes in a
separate object store," which is **precisely what iterate already has** (a
content-hash _fact_ + bytes in **R2**), but LFS adds a second protocol, a
required `git-lfs` client in every agent runtime and CI job (missing client →
silent 130-byte pointers), separate auth that drifts, provider quotas that can
lock you out of your own bytes, brutal history-rewrite migrations, and per-file
caps (GitHub **5 GB**). It buys iterate nothing over "R2 + immutable content-hash
pointer fact," and iterate can't easily run an LFS/GVFS/Scalar cache server as
first-class Cloudflare infra anyway. **Keep bytes in R2, keep the pointer as a
content-addressed journal fact; skip LFS entirely.** (git-annex is the honest
prior art for this exact pattern and it, too, keeps bytes out of Git.)

**(c) The search index in Git — No; keep it derived and unstored.** A search /
vector index is a **fold of the events + blobs** — pure derived state, the same
category as reduced state and build artifacts, which iterate _already treats as
disposable_ (checkpoints are discarded on `CORE_STATE_VERSION` bumps _on
purpose_). Committing a vector index into Git means: huge binary blobs that don't
diff or dedupe, that change on nearly every event, that bloat history unboundedly
(you can never GC it without rewriting history), and that must be rebuilt on
schema/model change anyway. **The index should be rebuildable from the durable
streams + blobs and never live in Git.** This is the general rule: **derived
state is a cache, not durable substrate.**

**(d) "Git commits references to R2" hybrid — this IS the answer, and it barely
differs from keeping the (right) stores.** The manifest-in-Git-pointing-at-a-
content-addressed-blob-store is the proven pattern (git-annex; Dolt's NBS on S3),
and iterate is **already this hybrid** ([[D9]] events reference blobs; `build-
key.ts`/`resolveFileSource`/`artifact-store.ts` content-address builds and
resolve names→hashes; `lens-content-addressed.md` reaches the same verdict from
the code). But note what the hybrid actually collapses the four stores _to_, and
what it doesn't:

- **Event streams: stay.** They are the durable append log and the pre-commit
  buffer; §2 forbids replacing them with commits.
- **R2 blobs: stay** — as the byte plane behind content-hash pointers. (Whether
  the pointer is a Git object or a stream fact is a detail; it must not be a
  commit-per-put.)
- **Search index: goes away as a _store_** — it becomes derived-and-unstored.
- **Git repo: stays, but shrinks in ambition** — it holds the **code/genome**
  and, at most, **periodic manifest checkpoints**, not the live event log and
  not the bytes.

So "everything is one Git repo" resolves, honestly, to **"three stores, one of
which (the search index) becomes derived":** durable **event streams** +
content-addressed **R2 bytes** + a **Git repo of code and pointers**. That is a
real simplification (4 → 3, and the survivors have crisper roles), and it is the
direction iterate's own design already points. The two hard rules that make it
safe: **(1) never commit-per-event — Git holds code and periodic pointer
snapshots, the stream holds the live log; (2) never store derived state
(search/reduced state) in Git — rebuild it from streams + blobs.** The remaining
prize the hybrid unlocks is orthogonal to storage-count: **content-address the
resolved lock and stamp events with an image/commit hash** so replay is exact
across self-modification ([[D9]]/[[D19]]) — the one place content-addressing
should reach _inside_ the journal — while the authoring surface stays
files-and-git, because the primary user is an LLM trained on files and the
Unison/Nix/IPFS graveyard is the graveyard of systems that made humans edit
hashes.
