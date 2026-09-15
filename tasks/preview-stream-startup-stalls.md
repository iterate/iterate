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


## Review rerun: 2026-09-15

The 16-worker, zero-retry review batch reproduced this symptom in the script-reuse spec before its first send (`specs/agent-script-reuse.spec.ts:218`). Project `agent-script-reuse-typed-mu2gu9ra-51c03c68`, stream `/agents/agent-script-reuse-typed-c15ea2b2`. The page stayed on “Initializing agent”; Send remained disabled for the full 60-second spinner budget. Its `wa-sqlite-XZW__iJk.wasm` request began at 09:25:10.027 UTC and received 200 headers, but the trace records `receive: -1`, `content.size: -1`, and no completed response body. This is matching evidence, not proof of which network/worker step stalled.

Evidence: `.flake-validation.ignoreme/review-repeat24/playwright-output/agent-script-reuse-run-ret-d6565--data-through-the-real-gate-web-repeat10/{trace.zip,error-context.md}`. Test head `dadd42f98`, SDK `e165a68cb`, OS `9bfe9dab-7752-4f34-a5fa-844de6c1d644`, published Middlewright `e3f2374`. This run exercised the normal first-send path with no warm-up agent. Neither timeouts nor the allowed-flake pattern were changed.


The same batch had three mobile fixture failures before reaching Notes: OAuth `authorize` returned 429 at 09:28:34.653 and 09:28:45.679 UTC; OAuth `register` returned 429 at 09:28:54.419 UTC. The last page displayed `OAuth client registration failed: Too many requests. Please try again later.` These are captured in `review-repeat24/playwright-output/mobile-notes-…-repeat{13,20,23}`. Do not convert these into Notes/inputValue failures or hide them with retries; investigate the preview auth capacity and fixture request volume separately.

The stress-run OS audit recorded five registry alarm-arming errors, two ITX `LiveStateRelay.subscribe` server errors after roughly five seconds, and one `/repos/config` hosted-processor acknowledgement timeout after 20 seconds. Subscribe traces: `06b1effa21fddb600028e67835a8c846`, `368526acbc2fab802639fd16b7dbb923`; callback trace `ee7fa4c305ee839e6d2a55ce108412c2`, project `prj_d281a29f9146454aaeafc50893f7f92b`. These are unresolved reliability/telemetry findings, not classified as harmless. Evidence: `review-repeat24-errors.json`, `review-subscribe-{a,b}.json`, `review-durable-callback.json` in the same retained folder.


The callback's repository was checked at 09:31:23 UTC: `repo` and `feed` both confirmed offset 17/17, active, zero lag, zero retry attempt, no next attempt/deadline/error. Recovery of those inspected subscribers is confirmed (`review-repo-recovery-probe.json`); the original latency and alarm/subscription errors still need explanation.
