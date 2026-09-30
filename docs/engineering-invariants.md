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
  on any 5xx a first-party prd Worker answered a visitor, and on errors.
  Retries follow one policy:
  [Failures and retries](#failures-and-retries).
- A workaround for an upstream defect (a library, Cloudflare, a vendor) stays
  only while a [`createFailing`](testing.md#pinned-bugs-createfailingtest--not-bare-testfails)
  test pins the defect, so the pin goes red once upstream fixes it. The
  exception is a defect too rare to reproduce in a test, such as the held
  Durable Object alarm ([alarm-coordinator.ts](../apps/os/src/alarm-coordinator.ts)).
  Its heal's absence from prd is the pin: `PINNED_WORKAROUNDS` in the prd fault
  alarm posts once after 28 days without it. An upstream defect that only logs
  an error line, where no call failed, gets no workaround: a `createFailing`
  test pins it (its upstream issue, where only a deployed runtime shows it), and
  its entry in the alarm's `PINNED_LINES` says where the line still pages.
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

## Failures and retries

Every failure is one of five kinds. The hop that first sees it decides the
kind (`failureKind` in
[platform-retry.ts](../packages/iterate/src/platform-retry.ts)), and the kind
rides on as own properties, which Workers RPC and capnweb keep.

| Kind           | Recognized by                                                                                                                                                                                                                                                                                                                                     | Repeated                                                                                                                                          | Answered as            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `refused`      | a `code` from iterate/lib's `ErrorCode`                                                                                                                                                                                                                                                                                                           | never                                                                                                                                             | 4xx or a typed answer  |
| `deploy-reset` | "reset because its code was updated" (a Durable Object's or D1's)                                                                                                                                                                                                                                                                                 | once, at once, on a fresh stub, if idempotent                                                                                                     | 503, `Retry-After: 1`  |
| `disconnected` | workerd's `retryable: true`; a storage reset; D1's documented transient errors; an HTTP 5xx or dropped connection; Artifacts 10400, or an Artifacts call left unanswered 20 s (`ARTIFACTS_ANSWER_MS`) while it answers the calls around it; Browser Run 6002 on inline HTML; Cloudflare's own not-found for a workers.dev hostname not routed yet | once at once on a fresh stub (RPC), once a second later (an upstream API), or on a script's schedule (`CI_HTTP`, `CLOUDFLARE_API`), if idempotent | 503, `Retry-After: 1`  |
| `overloaded`   | workerd's `overloaded: true` (a storage timeout, a memory limit); D1's overload, or workerd's opaque "internal error; reference = …" on a D1 call; HTTP 429 or 408; our own deadline                                                                                                                                                              | never at once: only a durable ladder, or the caller after `Retry-After`                                                                           | 503, `Retry-After: 10` |
| `failed`       | anything else, our own defects and workerd's opaque internal error on any other call included                                                                                                                                                                                                                                                     | never, except a named workaround with a pin                                                                                                       | 500, and `reportIssue` |

- **Idempotency decides whether a call is repeated; the kind decides when.**
  Idempotent means a read, an append whose every event is durable and keyed, a
  `processors.enable`, a GET or HEAD with no body, or a script's call on a
  method that names its whole end state. A request answered 429 was refused
  unrun, so a script sends it again whatever its method, and so does the e2e
  transport with one Cloudflare answered not routed yet (`isNotRoutedYet`,
  [not-routed.ts](../test/helpers/not-routed.ts)). `contextStub`
  ([context-stub.ts](../apps/os/src/context-stub.ts)) applies this to every
  call the platform makes on a context Durable Object, whichever hop makes it.
- **Schedules come from one short list**: `ONCE_NOW`, `UPSTREAM_ONCE`,
  `RELAY_BURST`, `CI_HTTP`, `CLOUDFLARE_API`, the durable ladder (1 s·2ⁿ,
  capped at 30 minutes), and the socket re-dial
  ([redial.ts](../apps/os/src/context/redial.ts): at once, then 250 ms doubling
  to 8 s, within the caller's deadline of the drop: 60 s for a lent stub's pager,
  30 s for a resumable upgrade). Each schedule is bounded, each wait but the
  re-dial's is jittered, and giving up on an idempotent call is logged once. A
  `Retry-After` longer than a wait replaces it, up to the schedule's longest
  wait. A script's HTTP call goes through `fetchRetryingPlatformFailures`, whose
  attempt that gets no answer in time is our own deadline, an overload.
- **A platform failure that stands crosses a hop as `UNAVAILABLE`**, its
  `data` `{ kind, retryAfterMs }`, and the edge answers it 503 with that
  `Retry-After` ([unavailable.ts](../apps/os/src/unavailable.ts)). "Never retry
  this" is a code (`PERMANENT_FAILURE`, or the refusal's own), never
  `retryable: false`: workerd never sets it.
- **One event naming rule, `<module>.<outcome>`.** A deploy's reset is
  expected: `<area>.deploy-reset-<action>` at info. Any other platform failure
  is `<area>.platform-failure-<action>` at warn, carrying the `name` the prd
  fault alarm groups by.

Sources:
[Cloudflare's Durable Objects error handling](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/)
(`.retryable` may be retried when idempotent, `.overloaded` "should not be
retried", a new stub after an exception);
[capnp's `Exception.Type`](https://github.com/capnproto/capnproto/blob/v2/c%2B%2B/src/capnp/rpc.capnp)
(OVERLOADED: "should NOT retry again immediately"; DISCONNECTED: rebuild and
retry);
[workerd](https://github.com/cloudflare/workerd/blob/main/src/workerd/jsg/util.c%2B%2B)
(DISCONNECTED is stamped `retryable`, OVERLOADED `overloaded`; a storage
timeout is thrown OVERLOADED in `io/worker.c++`);
[D1's error list](https://developers.cloudflare.com/d1/observability/debug-d1/#error-list).
