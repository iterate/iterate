---
status: ready
size: large
---

# Flake dashboard: stream, processor, CI wiring, transitions

Phases 2–3 of the `createFlake` work (phase 1 — the wrapper, recorder, and sentinel — landed via `tasks/create-flake.md` / PR #2562). Design decisions were grilled and approved 2026-09-01; see that task file for the full decision list and prior-art research.

The wrapper already writes one JSONL line per flake-test outcome to `FLAKE_RECORD_DIR` (schema: `FlakeRecord` in `packages/shared/src/test-support/flake-test.ts`). This task makes the data go somewhere and come back as decisions.

## PR A — stream side (deployable without touching CI)

- [ ] Event contract: `events.iterate.com/flakes/run-recorded`, payload `{runId, lane, branch, commit, records: FlakeRecord[]}`, idempotency key `runId+lane` (CI retries must not double-count)
- [ ] `flake-dashboard` starter app in `packages/iterate/src/starter-apps/`, modeled on `github-ai-linter`: a `/flakes` stream born with its processor subscription (birth-certificate doctrine), and a `FlakeDashboardProcessor` folding per-test stats — rolling-window flake rate, last flake, per-branch split
- [ ] GitHub issue render as an obligation-pattern side effect: get-or-create "Flake dashboard", issue number in state, body re-rendered from folded state on change. Single writer by construction. GitHub capability injected like the AI linter's `publishReview`, so the node harness (MemoryStream + refold test) covers it with a fake GitHub
- [ ] Wire the starter app into the iterate project's own config (`configs/default`) — the prd project already running the AI linter on this repo
- [ ] Ordering check (from `config-templates-run-against-deployed-schemas` experience): confirm prd accepts the new event type before the config template references it

## PR B — CI wiring

- [ ] Set `FLAKE_RECORD_DIR` in the test lanes; recorder files ride the existing raw-artifact contract (no new upload path)
- [ ] Extend the always-running CI telemetry finalizer: gather recorder files, batch one `run-recorded` event per run+lane, append via the project's `/api` (itx) with a project API key from Doppler (remote-apps inbound pattern). Fire-and-forget with a short timeout — prd being down gaps data, never reddens or slows CI

## PR C — transitions

- [ ] Processor watches folded stats for threshold crossings: unwrap after 50 consecutive default-branch passes over ≥5 days; propose `failing` after 25 consecutive matched failures over ≥2 days; clean window resets on any edit to the test file (commits are in the events)
- [ ] On crossing: append a `transition-proposed` event and message an agent facet to open the actual unwrap / switch-to-`failing` PR (callsite edits are a codemod — agent-shaped work, not processor file surgery)
- [ ] Sentinel lifecycle check: when a sentinel's month ends, the unwrap proposal should fire — the monthly reminder to roll it forward, and proof the transition path works

## Notes

- Quarantine state needs no storage anywhere: the wrapper at the callsite IS the state (approved decision — lifecycle is wrapper-switching, not a quarantine list)
- PostHog's `test_outcome` can't distinguish pass from flake-fail (both satisfy expected-fail) — the recorder lines are the only source for that split
