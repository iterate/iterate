# Code review: itx.search (PR #1782)

High-effort review of the full PR (branch `gorgeous-savory` vs `main`), run as two
parallel passes — correctness ("does it actually work") and idiom (house
conventions) — plus a research pass on Cloudflare's own "think" project.
`jonasland/RULES.md` was not found in the repo or the skill directory; the idiom
pass reviewed against `docs/coding-style.md`, `docs/typescript-conventions.md`,
exemplar RpcTargets, and Jonas's recorded review rules instead.

## Findings and resolutions

| #    | Severity    | Finding                                                                                                                                                                                                                                                                                                                                                                  | Resolution                                                                                                                                                                                                                                                                                                                                                                                  |
| ---- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **Blocker** | `ensure-resources.ts` imported `SEARCH_METADATA_SCHEMA` from `search-index.ts`, whose `itxEnv` import chain pulls `cloudflare:workers` — **broke `pnpm run deploy` and `ensure-resources` at import time under tsx** (verified by execution; the vitest shim masked it).                                                                                                 | **Fixed**: split the pure corpus model (keys, segment math, rendering, filters, metadata schema, kind validation) into runtime-neutral `search-corpus.ts` (mirrors the `project-files.ts` / `file-url-signing.ts` split); `search-index.ts` keeps the R2 writers. Both scripts now `IMPORT OK` under tsx.                                                                                   |
| 2    | **Blocker** | `itx.search.index()` accepted reserved kinds and slashes: `index({kind:"repos", id:"repos/config/files/x"})` wrote inside the repo sweep prefix → **the next commit's stale-key sweep silently deleted the user's document**. `kind:"docs"` bypassed `exclude:["docs"]`. Source prefix `prj/files` (no trailing slash) also matched `prj/filesystem/…`.                  | **Fixed**: `normalizeCustomSearchKind` throws on reserved kinds (`streams/files/repos/docs`) and on slashes/spaces; `projectSearchPrefix` appends a trailing slash for source scoping. Unit-tested.                                                                                                                                                                                         |
| 3    | Major       | `#indexStreamSearch` was bare fire-and-forget — the multi-hop segment re-read + R2 puts could be **cancelled when the RPC's I/O context ends**, making the "rare tail gap" common.                                                                                                                                                                                       | **Fixed**: anchored with `this.#props.ctx.waitUntil(...)`.                                                                                                                                                                                                                                                                                                                                  |
| 4    | Major       | A missing AI Search instance killed docs federation too (`Promise.all` inside the hint wrapper) — `query()` unusable instead of degraded.                                                                                                                                                                                                                                | **Fixed**: `Promise.allSettled`; corpus failure returns docs results + `warning` naming the fix (errors-as-data); `answer()` still throws with the hint, now with `{ cause }`.                                                                                                                                                                                                              |
| 5    | Major       | One bad repo file path (unbounded, straight from git; R2 caps keys at 1024 bytes) **aborted the whole snapshot index and skipped the stale-key sweep**.                                                                                                                                                                                                                  | **Fixed**: per-file try/catch (`failed` count), key-byte-length guard, sweep always runs, failed keys retained (stale-but-real beats a hole).                                                                                                                                                                                                                                               |
| 6    | Medium      | `folder < "prefix + U+FFFF"` used a Unicode noncharacter — unverified through CF's filter evaluation.                                                                                                                                                                                                                                                                    | **Fixed**: switched to Cloudflare's documented trick — bump the trailing `/` to `0`. Verified the "one projectId is a prefix of another" case in tests.                                                                                                                                                                                                                                     |
| 7    | Medium      | Custom-metadata round-trip in `attributes` on the **deprecated** legacy `env.AI.autorag()` binding is unverified; code is crash-safe if absent.                                                                                                                                                                                                                          | **Open — live verification** (next phase: create instance on preview+dev account, prove `kind`/`context` come back on hits). Migration to the standalone AI Search binding noted as follow-up.                                                                                                                                                                                              |
| 8–14 | Minor/nit   | Silent `{segments:0}`; stale segment docs never deleted; SPIKE in generated contract; hand-rolled `.iterate/` prefix + raw bucket I/O in rpc-targets; single-use one-line helpers; `String(error)` instead of `cause`; warn/error inconsistency; defensive hedges in ensure-resources; `readonly` param; `#instance` getter; SDK type reuse; literal `100` in docstring. | **All fixed**: null-render segments now delete their doc; SPIKE removed from contract docstrings; `listProjectFiles` pager added to project-files.ts (codec-owned keys); helpers inlined; `{ cause }` chaining; standardized on `console.warn` for self-healing mirror failures; hedges dropped; `readonly` added; getter; `AutoRagSearchResponse["data"][number]`; docstring de-literaled. |

## Product decisions taken (Jonas, this session)

- **Index `/integrations/**` webhook streams\*\* — duplicative but valuable; accepted
  embedding cost; payloads truncated at 8k chars/event.
- **Index `/secrets/**`streams too** — verified safe: secret events carry`encryptedMaterial.ciphertext` (encrypted at rest), never plaintext.
- Net: **every stream is indexed; the only exclusions are ephemeral events**
  (structurally excluded — durable delivery doesn't carry them, default reads skip
  them) and the housekeeping event-type disallow list (woken/presence/child-stream).

## Cloudflare "think" research (inspiration check)

Cloudflare's `think` (in cloudflare/agents) has **zero AI Search integration** — the
framework's own search is per-agent DO-SQLite FTS5 working memory. The relevant
official patterns (docs how-tos) confirm our design and suggest follow-ups:

- Our shared-instance + folder-prefix-range tenancy is **Cloudflare's documented
  pattern** ("many small tenants, simplest setup").
- Their recommended direction for stronger isolation is **runtime instance-per-tenant**
  via the `ai_search_namespaces` binding (follow-up option).
- **Event-driven freshness**: trigger the sync-jobs API after writes (min 30s apart)
  instead of waiting for the hourly schedule; or use built-in storage `items.upload()`
  for index-in-seconds writes. Follow-up.
- Their human-in-the-loop KB demo persists upload receipts so every index write has a
  compensating delete — rhymes with our stale-key sweeps.

# Plan (TODO)

- [x] Remediate findings 1–6, 8–14 (this commit)
- [ ] Live proof on the preview+dev account (task #10/#12): run ensure-resources to
      create `os-search` over `os-search-index` (verify the REST create body incl.
      `custom_metadata`), index real content, trigger a sync job, run `query`/`answer`,
      verify finding 7 (`attributes` round-trip) and tenancy filtering.
- [ ] Update PR description.
- Follow-ups (PR-noted, not this spike): standalone AI Search binding migration,
  sync-job trigger after writes, instance-per-project via namespaces binding.
