---
state: todo
priority: high
size: medium
tags: [ci, e2e, playwright, vitest, quarantine, flake]
---

# Restore preview tests quarantined after first-attempt failures

Eight live preview tests were quarantined on 2026-07-21 while landing PR
#2169. Its new retry accounting did exactly what the testing policy requires:
although every test eventually passed, a failed first attempt made the preview
proof red instead of silently treating the retry as success.

## Evidence

The exact-head run was
[Depot job c62bw8r9sg](https://depot.dev/orgs/0p91s0lz49/workflows/xd64rslx1v?job=c62bw8r9sg)
at commit `255fff94acfe6834adc01f2b0dcb270de41315b3`. OS took 181s and the
Streams example app took 73.6s. The retry telemetry recorded:

- `kill reconnects and appends a new woken event`: event count remained `3`
  instead of reaching `5` for 30s; retry passed in 8.4s.
- `control: appended event is delivered to a live stream feed`: the browser
  runtime registry remained `{}` until the 1.7-minute attempt failed; retry
  passed in 13.2s.
- `agent replies to a browser chat message in the feed`: hydration stayed at
  `<body data-hydrated="false">` for 30s; retry passed in 19.2s.
- `loads project navigation only when it opens`: the same 30s hydration stall;
  retry passed in 11.5s.
- `opening OS returns to the most recently active project`: the same 30s
  hydration stall; retry passed in 9.9s.
- catalogue example `repo-edit-file`: `internal error; reference =
  qki1kt3bctlvpsekd0l6cble`; both attempts consumed 56.6s in total.
- catalogue example `run-script`: the CLI runtime reported `Network connection
  lost` with itx call `log_8bef83d5d67d48b7bc4255b2e66af9b3`; both attempts
  consumed 16.7s in total.
- `log, commitDetails and pinned readFile over a few commits`: `Durable Object
  reset because its code was updated`; both attempts consumed 36.8s in total.

These are not assertion changes hidden by this PR. Against `origin/main`, the
five directly skipped OS spec/Vitest files are unchanged, the Streams spec
only imports the shared retry-aware Playwright fixture, and the catalogue
runtime helper only adds diagnostic stderr to the same thrown CLI failure.
The failures span independently named projects and then pass with fresh
attempts, matching the fleet-wide preview instability that motivated explicit
retry failure and quarantine rather than reruns-until-green.

## Quarantined coverage

- The five Playwright tests above use narrow `test.skip` markers.
- The repo-history Vitest test uses a narrow `test.skip` marker.
- The two generated catalogue cases remain discoverable but are registered
  with Vitest's skipped test API. Other catalogue examples and runtimes still
  run.

## Work

- Correlate the three simultaneous hydration stalls with browser console,
  asset responses, `/api` WebSocket setup, and OS traces from the retained
  Playwright artifacts.
- Reproduce the stream wake/reconnect miss under the full Streams app load and
  determine why the replacement incarnation emitted no visible facts.
- Resolve the empty browser runtime registry in the nominal stream control
  case before trusting the suspend/recovery cases around it.
- Use the recorded internal reference and itx call ID to identify the
  server-side failures behind the catalogue cases.
- Explain why a Durable Object was still reset for a code update after the
  deploy phase had completed; do not classify or absorb that reset as normal.
- Split independent product defects into focused tasks once each failure is
  reduced; keep this task as the checklist owning every skip until then.

## Exit criteria

- Every skipped test is restored and passes on its first attempt in the normal
  fully parallel preview lane.
- A retry-disabled repeated preview run exercises each restored test at least
  20 times with zero flakes and no unexplained errors, resets, or lost
  connections in the corresponding traces.
- The hydration, stream delivery, and Durable Object outcomes are each either
  fixed as product defects or explicitly modelled outside error telemetry with
  evidence; passing retries alone are not acceptance proof.
