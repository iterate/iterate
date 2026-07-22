# The lazy repo lane: clone-free reads and commits against Artifacts

**Status**: shipped behind `RepoDurableObject` (PR #2262) · **Owners**: repos domain
**This is the running pressure-test + limitations document.** Add findings here; do not let them live only in PR comments.

## Why it exists

The repo Durable Object used to equate every read with _possessing the whole repository_: any head move re-cloned the full pack into an in-memory filesystem (iterate/iterate: ~37 s), and every `commitFiles` cloned too. One pushed commit made the next board load pay ~37 s twice. The requirement driving the redesign: **a repo much larger than iterate/iterate, holding thousands of tasks, has to stay efficient end to end.**

## Architecture

```
                        RepoDurableObject
   ┌────────────────────────────────────────────────────────────┐
   │  readFile / listFiles / getFilesSnapshot({paths})          │
   │  commitFiles                                               │
   │        │ lazy-first, clone-lane fallback                   │
   │        ▼                                                   │
   │  lazy-repo-reader.ts     ←— freshness policy stays in the  │
   │   syncToHead(target)         DO: candidates are validated  │
   │   readHeadPaths/listHead     against the branch authority  │
   │   commitFiles → typed        (decideHeadResolution) before │
   │        │        outcome      and after every install       │
   │        ▼                                                   │
   │  repo-object-store.ts    — durable SQLite snapshot:        │
   │   objects (oid → chunked bytes, verified on read)          │
   │   manifest (branch, path → blob oid, mode)                 │
   │   dir trees (the `have`s), heads                           │
   │        │                                                   │
   │        ▼                                                   │
   │  git-wire.ts             — protocol v2: ls-refs, fetch,    │
   │   receive-pack, pack codec (deltas, strict validation)     │
   └────────────┬───────────────────────────────────────────────┘
                ▼
        Artifacts git endpoint ("gitty/1.0")
```

- **One byte authority for lazy reads.** Reads are `manifest lookup → verified blob bytes`, labeled with the head they came from, captured under one serialization barrier (`readHeadPaths`). The pre-existing byte-tree + clone machinery is untouched and serves as the fallback lane.
- **Sync is delta-priced.** `want <target>, deepen 1, have <every known dir tree>` — the server excludes unchanged subtrees recursively; blobs the exclusion swallows (rename/copy into a changed directory) hydrate by exact oid.
- **Commits are built locally** (blobs + only the changed ancestor-chain trees + commit), pushed as one small pack under a compare-and-swap, and installed into the store — read-your-write costs zero network.
- **Outcomes are proofs.** `applied` / `rejected` (remote provably unmoved — the only state that may fall back to the clone write lane) / `indeterminate` (reconciled against the ref; surfaces as an error rather than risking a double commit).
- **Lifecycle is bounded by construction.** `installSnapshot` prunes every object unreachable from any branch's live snapshot in the same transaction. No LRU, no budget: storage ≈ the working set.

## The wire contract (all empirically probed against gitty/1.0)

| Behavior                                | Status                                                    |
| --------------------------------------- | --------------------------------------------------------- |
| protocol v2: `ls-refs`, `fetch=shallow` | ✔ (push is v1 receive-pack)                               |
| `filter` (partial clone)                | ✘ silently ignored — never rely on it                     |
| `want <arbitrary oid>` (blob/tree)      | ✔ exact-object packs — the hydration primitive            |
| `deepen 1`                              | ✔ cuts the commit walk                                    |
| `have <tree>` inside the want closure   | ✔ ACKed, excluded **recursively with its closure**        |
| `have` outside the closure              | ignored (safe over-fetch)                                 |
| missing `want` oids                     | silently dropped — receipt must be verified               |
| `ref-prefix` on ls-refs                 | ignored — filter client-side                              |
| packs                                   | self-contained, type-interleaved, ofs- **and** ref-deltas |

## Measured (2026-07-22/23, dev-namespace Artifacts, full reader stack)

| Repo                                                              | Cold ingest                   | Incremental resync after a push | Scoped read                  | 1-file commit | RYW  |
| ----------------------------------------------------------------- | ----------------------------- | ------------------------------- | ---------------------------- | ------------- | ---- |
| iterate/iterate snapshot (1,851 files / 43 MB text / ~20 MB pack) | 3.4 s                         | 334 ms                          | 74 task files: **4 ms**      | 148 ms        | 0 ms |
| **10,000 task files** (4k in `tasks/` + 30 team dirs × 200)       | **1.3 s**                     | 580 ms                          | **all 10,000 files: 250 ms** | 501 ms        | 0 ms |
| linux kernel snapshot (94,843 files / ~281 MB pack)               | **fails server-side** (below) | —                               | —                            | —             | —    |

Prod (deployed pair, before this branch merged — clone lane): the same iterate/iterate cold read was **36.9 s**, re-paid after every push; warm 438 ms.

## Known limitations (ranked; documented, not hidden)

1. **Kernel-scale repos fail at the SERVICE, not the client.** Artifacts' upload-pack returns HTTP 500 after ~73 s for the 281 MB-pack kernel snapshot — real `git clone --depth 1` fails identically, so the clone lane is equally dead. The practical ceiling sits somewhere between a ~20 MB pack (works, fast) and a ~281 MB pack (server 500). Pushing the same repo INTO Artifacts worked (6 min), so ingest and serving limits differ. Follow-up if kernel-scale becomes real: manifest-first cold sync (batched tree-only wants — the arbitrary-oid want primitive already supports it) + blob-on-demand, which also sidesteps the isolate-memory point below.
2. **Cold ingest buffers the pack ~3× in memory** (HTTP response + demuxed pack + inflated objects). Fine to ~40-50 MB packs inside a 128 MB isolate; beyond that cold ingest would OOM and fall back to the clone lane (which has the same ceiling). Streaming pkt-line → incremental pack parse → store writes is the designed successor; the wire client isolates that change to one module.
3. **Commit compile holds the full manifest in memory** — O(repo paths) per commit (~10 k rows ≈ tens of ms; ~100 k ≈ ~100-300 ms). Tree building is already ancestor-only; the manifest map is the remaining O(repo) piece. SQLite-side diffing is the follow-up if profiles ever show it.
4. **Reads serialize with installs** (one chain). Correctness first; a reader/writer barrier is a measured-need optimization. Read latency at 10 k files (250 ms for the full set) says this is nowhere near binding.
5. **Every read re-verifies SHA-1** (~µs/KB). At current sizes this is noise (4 ms for 74 files). A verified-once memo per isolate is a possible micro-optimization; deliberately not built without evidence.
6. **Capabilities are asserted, not negotiated.** The receive-pack capability line and pako's `strm.avail_in` are validated loudly at runtime and documented as gitty-specific; a server or pako change fails into the clone lane with a clear message.
7. **`edit()` still uses the clone lane.** Same recipe applies if it ever matters; it is the rare lane.

## Test harness (no vitest-pool-workers anywhere)

- **Wire** (`git-wire.test.ts`, 22): byte-golden fixtures from real git; delta chains incl. forward ref-delta and ofs-on-ref; corrupted trailer/version/bounds; three-state push report classification (applied / rejected / **indeterminate on truncation**).
- **Reader + store** (`lazy-repo-reader.test.ts`, 25): REAL SQLite transactions (`BEGIN IMMEDIATE`/`ROLLBACK`) with statement-level fault injection — install atomicity, pushed-then-install-fails, chunk corruption (mutated AND missing chunks) with quarantine + rehydration, corrupt-tree self-healing, multi-branch reachability pruning, gitlinks, empty-tree commits, final-state conflict validation, CAS conflict retry with true parents, transport-death reconciliation (applied / rejected / indeterminate), storage-bounded-after-5-commits.
- **E2e** (`repo-lazy.itx.e2e.test.ts`, real worker + real Artifacts): batched commit → RYW at the itx surface → listFiles → stacked commit → `log` sees lazy history → clone-lane `edit` interleaves → lazy commit on the clone-lane head.
- **Live probes** (`scripts/probe-git-wire-live.ts`, `scripts/probe-lazy-reader-live.ts`): the full stack against real Artifacts repos, env-gated.

## Review provenance

Three adversarial thermo-nuclear rounds (self-review + Codex gpt-5.6-sol, xhigh reasoning, independent runs). Round 1: BLOCK → single-byte-authority restructure, typed outcomes, bounded lifecycle, verified reads. Round 2: BLOCK → exhaustive DO commit boundary (double-commit hole closed), three-state push reports, serialized observations, self-healing trees, post-install authority re-check, final-state validation, forward-delta fix. Round 3: convergence check (see PR).
