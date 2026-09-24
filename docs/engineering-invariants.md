# Engineering invariant: no deviant system behaviour

We do not accept unexplained, unbounded, or silently tolerated system
behaviour. An error is either an explicitly modelled and correctly classified
expected outcome, or it is a product defect. The same rule applies to retry
storms, stuck work, silent data loss, unexplained latency, state drift, and
resource leaks.

- Never normalize an error counter merely because it is noisy or longstanding.
  Classify every contributing outcome, remove expected outcomes from error
  telemetry, and fix the rest.
- Never swallow, endlessly retry, or hide failures behind fallbacks or
  compatibility shims. Recovery must be bounded, observable, and preserve a
  durable explanation of what happened. A workaround that heals a platform
  fault logs a warn whose `event` is `<area>.platform-failure-<action>`: the
  [prd fault alarm](../scripts/ci/prd-fault-alarm.ts) pages on bursts of those,
  on any os-prd 5xx, and on error bursts.
- A workaround for an upstream defect (a library, Cloudflare, a vendor) stays
  only while a [`createFailing`](testing.md#pinned-bugs-createfailingtest--not-bare-testfails)
  test pins the defect, so the pin goes red once upstream fixes it. The
  exception is a defect too rare to reproduce in a test, such as the held
  Durable Object alarm ([alarm-coordinator.ts](../apps/os/src/alarm-coordinator.ts)).
  Its heal's absence from prd is the pin: `PINNED_WORKAROUNDS` in the prd fault
  alarm posts once after 28 days without it.
- A healthy request is not enough if it leaves corrupt, stalled, or divergent
  state behind. Verify the resulting state and the relevant production-shaped
  telemetry.
- Green tests are necessary but not sufficient. For operational changes, the
  acceptance proof includes a preview deployment and evidence that its traces,
  logs, metrics, and state transitions are coherent, correctly classified, and
  free of new unexplained errors.

Treat any unexplained error volume as a release blocker until evidence proves
that each outcome is expected and correctly represented outside the error
signal. "Unavoidable error spam" is not a category.
