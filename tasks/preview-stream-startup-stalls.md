---
status: ready
size: medium
---

# Explain the remaining preview stream startup stalls

The Playwright flake investigation found two startup failures in a 16-worker batch. Neither reached the freeze stimulus. They remain ordinary failures; no timeout increase or quarantine hides them.

- [ ] Bound and explain a stalled browser SQLite startup. *Observed: the WASM request returned HTTP 200 headers but no completed body appeared in the trace before the baseline's 30-second deadline. The browser mirror had a client, no event connection and no delivered events. Check whether the body download stalled or the browser worker failed to report completion; don't assume an OPFS bug.*
- [ ] Trace the keyed append timeout during agent creation. *Observed: `stream-unavailable: keyed stream append received no response within 10000ms`. Keep the durable outcome/idempotency evidence when a caller times out; do not add a whole-test retry.*
- [ ] Audit the reset/recovery errors recorded during these runs. *A brief Cloudflare internal-storage reset burst caused delivery-gap errors; the inspected project, agent and repository processors subsequently caught up. Separate the platform failure from any defect in our recovery or error classification. Registry alarm-arming failures also need a useful durable cause, not only a stack.*

Evidence is in the retained worktree `/Users/mmkal/src/worktrees/iterate/playwright-flake-causes/.flake-validation.ignoreme/`: `final-16workers/`, `freeze-mirror-1.json`, `freeze-baseline-probe.json`, `telemetry-final-16workers-errors.json`, and `telemetry-acceptance-errors.json`.

The missing baseline belonged to project `prj_2338f41ebfaa473b8174f3c396fb8b1d`, stream `/agents/suspend-freeze-f029fb01`, at 2026-09-14 23:11:53 UTC. The server published it at offset 51. The browser stayed on “Initializing agent”; the saved runtime snapshot remained `connecting`. The same WASM asset completed in all 16 successful fully traced comparison runs. OS version: `cb1ea6cf-25d9-4ef5-82af-3b689e24bde3`.

Run `specs/stream-resume-after-suspend.spec.ts` with `--grep 'feed resumes after page freeze' --retries=0 --repeat-each=40 --workers=8 --trace=on` against an isolated preview. That focused batch passed 40/40 after the two failures in the mixed 16-worker batch. To investigate further, record browser worker startup and the asset response body lifecycle before changing timeouts or reconnection behavior.
