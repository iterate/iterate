---
status: todo
size: medium
branch: gorgeous-savory
pr: https://github.com/iterate/iterate/pull/1782
---

# itx.search productionization: new binding, freshness, hygiene

PR #1782 shipped `itx.search` (Cloudflare AI Search over the per-env
`SEARCH_BUCKET` corpus) and live-proved it on preview 4. This task tracks the
follow-ups from the docs-research + dogfooding pass (2026-07-13), in priority
order. Background: `code-review-itx-search.md` and the PR description.

## 1. Migrate the query path to the `ai_search` binding

`env.AI.autorag()` is deprecated and blocks every knob we want next. The new
wrangler binding type is:

```jsonc
"ai_search": [{ "binding": "SEARCH", "instance_name": "<worker>-search" }]
```

(and `ai_search_namespaces` for runtime instance CRUD — the documented
instance-per-project upgrade path). New-binding-only features we want:

- `boost_by: [{ field: "timestamp", order: "desc" }]` — prefer fresh stream
  segments over stale ones.
- `context_expansion: 1..3` — return neighboring chunks (heals JSON payloads
  split across chunk boundaries in segment docs).
- `keyword_match_mode: "or"` — dogfooding showed AND-mode misses exact-token
  queries whose terms don't all co-occur in one chunk ("PR 413 token bucket").
- Per-query `retrieval_type` (vector/keyword/hybrid) and `metadata_only`.

Watch out for: (a) whether wrangler validates instance existence at upload —
envs without instances must still deploy (test on a fresh preview slot before
rollout); (b) the request shape changes (`ai_search_options.retrieval.filters`
with `$gte`-style operators — see the autorag-filter-format migration guide);
(c) response nests custom metadata FLAT (`item.metadata.kind`) where the
legacy binding nests it under `attributes.file` — `#toChunk` already reads
both.

## 2. Skip unchanged R2 puts (re-embed hygiene)

AI Search's R2 change-detection mechanism is undocumented; if it keys on
Last-Modified, every idempotent segment-doc rewrite re-embeds ~125k tokens for
nothing. Before each corpus put, `head` the key and skip when the md5/etag of
the new bytes matches. Cheap, and also cuts R2 Class A ops on redelivery.

## 3. Freshness: index-in-seconds instead of hourly

Two complementary lanes (Cloudflare's own pattern):

- **Sync-job trigger after writes**: call the create-job API (min 30s apart)
  from the indexing step, debounced per deployment (e.g. a DO alarm that fires
  at most every 60s while writes are dirty). Needs a management-scoped token
  in the worker env — blocked on the deploy token gaining "AI Search Edit"
  (dashboard task, link in PR thread).
- **Built-in storage for small hot docs**: `items.upload()` indexes in
  seconds and coexists with the R2 source. Natural fit for `itx.search.index()`
  documents (meeting notes etc.); streams/files/repos stay on R2.

## 4. Similarity cache stays OFF (tenancy)

The docs do not state the response cache key includes metadata filters; a
cross-tenant cache hit would leak. Do not enable until verified empirically
(two projects, same query, check `cf-aig-cache-status`).

## 5. Reranking per-query (optional knob)

Works on the legacy binding today (`reranking: { enabled, model:
"@cf/baai/bge-reranker-base" }`) — expose as a `rerank?: boolean` query param.
Note the reranker's 512-token input truncates our 1024-token chunks; if
reranking proves valuable, revisit chunk_size 512 / overlap 15% (full
re-index).

## 6. prd rollout checklist

- Dashboard click on the prd account: create the AI Search service token
  (`dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/ai/ai-search/tokens`).
- `wrangler ai-search create os-prd-search --type r2 --source
os-prd-search-index --custom-metadata kind:text --custom-metadata
context:text --hybrid-search` (hybrid from day one avoids the reindex).
- Set sync_interval 3600 (REST PUT; wrangler update lacks the flag).
- Backfill existing projects (`indexStream`/`indexRepo`/`backfillFiles`) —
  mind the 15k-webhook streams: embedding cost is fine (payloads truncate at
  8k chars/event) but do it deliberately.
- Grow `ensure-resources` to create instances itself once the deploy token has
  AI Search Edit (it already declares the metadata schema and degrades to a
  dashboard recipe today).

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
