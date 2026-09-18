# EXPERIMENT: measure lease cycling in the actual preview CI

Status: planned; the local experiment is complete but did not demonstrate a CI speedup. This follow-up runs the existing Depot preview pipeline on this branch without a PR.

## Scope and assumptions

Use the shared parallel deployment/readiness/app-test/browser-shard/finalizer workflow. Dispatch the existing main-preview wrapper on the experiment branch because Depot registers automatic triggers from main. Add only this branch to GitHub's package publisher push filter so each deployed SHA has real packages. Isolate experiment holders/concurrency from the main preview. Preserve all failures and compare actual traces, including the test verdict and later restoration.

Control keeps normal acquire/erase and 90s gate. Treatment consumes a verified, exclusively prepared, aged parked slot and skips redundant entry erase and the gate. Slot preparation time must be reported separately, never disguised as a CI saving. Unknown/stale receipts must fail closed. Existing PR/default-main behavior stays unchanged. These branch-only controls are experimental, not a production rollout of service tags or a final distributed cleanup scheduler.

- [ ] Enable branch package publishing and isolated real-CI control; run it.
- [ ] Test and implement branch-scoped prepared-slot validation and gate selection.
- [ ] Run the full treatment pipeline and compare readiness, test-verdict and settlement traces against the control and recent main.
- [ ] Inspect failures/telemetry, retain evidence in evidence.ignoreme, and document what the comparison proves.
- [ ] Verify all experiment leases/resources are left in an intentional state; commit and push, no PR.

Session: Codex 01a0b054-bdd8-7d52-9c01-30d9b92576c8.
