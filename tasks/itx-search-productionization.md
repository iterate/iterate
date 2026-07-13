---
status: todo
size: medium
branch: gorgeous-savory
pr: https://github.com/iterate/iterate/pull/1782
---

# itx.search productionization: freshness, hygiene, e2e

PR #1782 MERGED 2026-07-13 (416f9804b) and rolled out to prd the same day:
instance-per-project via `ai_search_namespaces`, every hit carries an
itx-expression ref (event-exact for streams), iterate prd project backfilled.
Remaining follow-ups from the docs-research + dogfooding pass, in priority
order. Background: `code-review-itx-search.md` and the PR description.

## 1. ~~Migrate the query path to the `ai_search` binding~~ DONE (in #1782)

Shipped before merge: the legacy `env.AI.autorag()` binding is gone. The
worker binds `ai_search_namespaces` (`SEARCH_INSTANCES`, namespace = worker
name) and creates ONE INSTANCE PER PROJECT lazily, scoped by
`include_items: ["{projectId}/**"]`. Hybrid search + trigram tokenizer from
birth, `keyword_match_mode: "or"` and `context_expansion: 1` at query time.
Still unused new-binding knobs: `boost_by` (timestamp recency) and per-query
`retrieval_type`/`metadata_only` — fold into item 5's knob pass.

## 2. Skip unchanged R2 puts (re-embed hygiene)

AI Search's R2 change-detection mechanism is undocumented; if it keys on
Last-Modified, every idempotent segment-doc rewrite re-embeds ~125k tokens for
nothing. Before each corpus put, `head` the key and skip when the md5/etag of
the new bytes matches. Cheap, and also cuts R2 Class A ops on redelivery.

## 3. Freshness: index-in-seconds instead of hourly

Two complementary lanes (Cloudflare's own pattern):

- **Sync-job trigger after writes**: call the create-job API (min 30s apart)
  from the indexing step, debounced per deployment (e.g. a DO alarm that fires
  at most every 60s while writes are dirty). Partially shipped: writes already
  trigger best-effort sync jobs via the SEARCH_INSTANCES binding (no separate
  token needed — the preview and prd deploy tokens both have AI Search Edit
  now anyway); the debounce/alarm coalescing is what remains.
- **Built-in storage for small hot docs**: `items.upload()` indexes in
  seconds and coexists with the R2 source. Natural fit for `itx.search.index()`
  documents (meeting notes etc.); streams/files/repos stay on R2.

## 4. Similarity cache: tenancy solved, freshness question remains

Instance-per-project made the cross-tenant leak structurally impossible — a
cache is scoped to its instance, and an instance only ever sees one project.
Note: namespace-created instances come up with `cache: true`,
`cache_threshold: "close_enough"`, `cache_ttl: 172800` (48h) by default
(observed on prd, 2026-07-13). That is now a FRESHNESS concern, not a tenancy
one: a close-enough repeat query can serve 48h-stale results. Decide whether
to disable cache or shorten TTL in `projectSearchInstanceConfig`.

## 5. Reranking per-query (optional knob)

Works on the legacy binding today (`reranking: { enabled, model:
"@cf/baai/bge-reranker-base" }`) — expose as a `rerank?: boolean` query param.
Note the reranker's 512-token input truncates our 1024-token chunks; if
reranking proves valuable, revisit chunk_size 512 / overlap 15% (full
re-index).

## 6. ~~prd rollout checklist~~ DONE 2026-07-13

Rolled out with the #1782 merge (416f9804b). Findings that made it smaller
than planned:

- NO dashboard service token needed: on an account with zero registered AI
  Search service tokens, `SEARCH_INSTANCES.create()` works — the platform
  wires the gateway itself (`token_id: null` on the instance). The preview
  account's `fail_while_checking_for_gateway` was a POISONED stale token, not
  a missing-registration requirement. Corollary unchanged: never edit a
  registered AI Search service token.
- The `os-prd` namespace already existed; the prd deploy token already had AI
  Search write (create returned 409, not 403).
- The legacy `wrangler ai-search create` recipe is obsolete — instances are
  per-project and lazy-created by the worker with hybrid+trigram+metadata
  schema from birth.
- Backfill of the iterate prd project (245 streams incl. the 15k-webhook
  GitHub install stream, 6 repos, files) executed deliberately on 2026-07-13.
  Other prd projects fill passively (per-event lane) + lazily on first query;
  backfill them only on demand.

## 7. e2e lane

One preview e2e: seed → sync job → query returns the seeded marker with
kind/context; tenancy negative check from a second project. (The manual proof
script recipes are in the PR thread.)

## Known non-goals / accepted limitations

- Images are vision-CAPTIONED, not OCR'd — text inside screenshots is not
  searchable (platform limitation).
- Custom kinds can be `exclude`d but not `source`-scoped (source is the closed
  streams/files/repos enum); revisit if custom kinds proliferate.
- Webhook near-duplication is an accepted embedding cost; segment batching
  already keeps it out of retrieval results.
