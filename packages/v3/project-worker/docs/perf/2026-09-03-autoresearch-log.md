# Performance autoresearch log — clean room (`packages/v3/project-worker`)

Started 2026-09-03. Goal (Jonas, AFK): optimise boot time, latency, throughput, CPU time and memory of
the clean-room implementation in an autoresearch loop — measure, hypothesise, change, re-measure, keep
or revert. Rules: no capability drops; LOC may grow at most 10 % and only for very meaningful gains;
NEVER make existing events ephemeral (`stream/woken` stays durable — most events will come from other
providers later); every proof and every number that counts is taken against the DEPLOYED worker
(`https://project-worker.iterate.workers.dev`), local workerd numbers are marked LOCAL; commit and push
each kept step. Bigger learnings and capability-dropping suggestions go to
`docs/perf/learnings-and-bigger-refactors.md`.

Every entry: what was measured (how, where), the hypothesis, the change, the numbers before/after,
KEPT or REVERTED, the commit.

## 0. Deploy and prove the clean room as it stands (prerequisite)

- `pnpm deploy` refused: the pre-rename class `StreamDurableObject` still had a provisioned namespace
  on workers.dev (an orphan). Retired with a `deleted` tombstone in `wrangler.jsonc` `exports`; the
  namespace `IterateContextDurableObject` was created fresh. Deployed version `41d795aa`.
  Wrangler's "Worker Startup Time: 17 ms" is the first boot number (the script's top-level evaluation
  at upload, measured by Cloudflare).
- Added DEPLOYED-TARGET MODE to the e2e lane: `WORKER_BASE_URL=<url> pnpm e2e` runs the same suite
  against the deployed worker with no local boot (`e2e/support/global-setup.ts`);
  `workers-remote-capnweb.e2e` skips unless `DUMMY_CAPNWEB_URL` names a public dummy.
- PROVED against the deployed worker (`WORKER_BASE_URL=https://project-worker.iterate.workers.dev pnpm e2e`):
  37 files passed, 1 skipped (workers-remote-capnweb: no public dummy), 145 tests passed, 2 expected
  fail, 2 skipped; 26.7 s wall on the laptop against the edge. Local workerd for the same suite:
  147 passed, 2 expected fail. The clean room as it stands works on Cloudflare.
- Cloudflare MCP: the OAuth flow needs a browser; the Chrome extension is not connected in this
  session, so observability is read through the Workers Observability API with wrangler's token
  (same data the MCP wraps). The MCP login URL is in the session transcript for Jonas to complete.
