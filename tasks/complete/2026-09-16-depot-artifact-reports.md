---
status: complete
size: medium
---

# Publish Playwright HTML reports through Depot artifacts

Implemented and verified end to end. Full local checks and the first complete CI run pass; both commit statuses were published automatically. The config viewer is deployed, with real report, screenshot and interactive trace proof.

## Request and decisions

Publish the merged Playwright HTML report through the generic Depot artifact viewer. Artifact roots open index.html, redirect a sole file, or show a generated listing. Use the existing upload mechanism and commit-status style; do not commit generated files.

- Upload the finished HTML report directory separately as `public-playwright-report`. Keep raw runner artifacts separate.
- Publish a `Playwright report` commit status whose external URL opens the report, including failed-test reports when produced. Report availability is distinct from the existing test outcome check.
- Resolve the artifact through Depot's current workflow and attempt identity, not the Actions upload action's numeric artifact ID. Do not let old runs replace newer commit-status links.
- Keep changes small and reuse existing CI coordination/publication where useful. Keep trace publication working when the config viewer becomes generic.
- Config viewer is deployed directly to main with explicit user authorization (e7e8bdc). Keep this CI wiring in PR #2690; do not merge it automatically.

## Acceptance

- [x] Add and validate report upload/link steps after merging shard results, including test failures. _`preview-run.yml` uploads the HTML directory with `always()`; the existing collector publishes its status._
- [x] Preserve trace report entry links under generic artifact root behavior. _CI trace publication and legacy trace links were verified against the live viewer._
- [x] Verify a real Depot artifact and browser report, including assets/attachments. _Workflow `w4r92n96sv`, collector `fw8jbk8506`, artifact `01a0ac41-9568-790f-ace8-1497c80446cf`; filters, original failure/retry, screenshot and trace DOM snapshots work._
- [x] Run relevant checks, capture visual proof, update PR descriptions and handle review feedback. _Install, typecheck, lint, knip, format and full tests pass; screenshots uploaded. Independent review prompted regressions for stale rerun artifacts and missing report-link repair. No GitHub review threads outstanding._

## Implementation log

Codex task: `01a0ac05-514e-78c0-b5ed-877ab8edfaa9`.

Implementation reuses the existing serialized report collector for both status links. Artifact selection matches the producing job attempt. The preview finish job uploads the merged HTML directory even after failing tests.

Publication verifies the hosted report and uses its final canonical entry URL. Exact attempt matching prevents retained old artifacts from being relabeled as new rerun results. Missing Playwright links can be repaired independently of an already-published CI trace.

The first report includes one existing flaky REPL test: its original Durable Object disconnect, passing retry and trace are visible. The viewer proof also caught a zip.js global extraction queue hang; the config fix includes a failing-then-passing slow-reader regression and is deployed in `iterate/config` (`2a18a7d`).
