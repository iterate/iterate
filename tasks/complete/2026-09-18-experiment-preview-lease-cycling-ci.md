# EXPERIMENT: measure lease cycling in the actual preview CI

Status: complete as an experiment. Both full CI runs passed and restored; a pre-rested slot reached green in 296.530s versus 391.084s for the control. Results, retries, reset evidence and retained lease ownership are documented. Production pool automation remains out of scope.

## Scope and assumptions

Use the shared parallel deployment/readiness/app-test/browser-shard/finalizer workflow. Dispatch the existing main-preview wrapper on the experiment branch because Depot registers automatic triggers from main. Add only this branch to GitHub's package publisher push filter so each deployed SHA has real packages. Isolate experiment holders/concurrency from the main preview. Preserve all failures and compare actual traces, including the test verdict and later restoration.

Control keeps normal acquire/erase and 90s gate. Treatment consumes a verified, exclusively prepared, aged parked slot and skips redundant entry erase and the gate. Slot preparation time must be reported separately, never disguised as a CI saving. Unknown/stale receipts must fail closed. Existing PR/default-main behavior stays unchanged. These branch-only controls are experimental, not a production rollout of service tags or a final distributed cleanup scheduler.

- [x] Enable branch package publishing and isolated real-CI control; run it. *Branch package publishing and isolated Depot dispatch are live; control run `9773d9q0hm` finished.*
- [x] Test and implement branch-scoped prepared-slot validation and gate selection. *Receipt races/live-state checks and defaults are covered by 60 focused tests; typechecks and lint passed.*
- [x] Run the full treatment pipeline and compare readiness, test-verdict and settlement traces against the control and recent main. *Treatment `z3jn76jx8p` finished and restored; CI_RESULTS.md compares verdict and settlement timings.*
- [x] Inspect failures/telemetry, retain evidence in evidence.ignoreme, and document what the comparison proves. *Raw data remains ignored; CI_RESULTS.md records two treatment retries and a separately tracked control alarm reset.*
- [x] Verify all experiment leases/resources are left in an intentional state; commit and push, no PR. *Both previews are intentionally retained under normal three-hour CI leases; ownership and health were audited. Results committed/pushed without a PR.*

Session: Codex 01a0b054-bdd8-7d52-9c01-30d9b92576c8.
