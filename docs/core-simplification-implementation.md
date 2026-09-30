# Simplifying the Iterate context

This breaking proof-of-concept keeps the context as an event log and an `itx`
namespace of ordinary Cap'n Web capabilities. The context owns append, read,
authority, inheritance and jails. The existing pager owns live RPC references.
Processors own progress. Trusted construction code owns Workers bindings.
Agents, voice and application policy use these facilities above the core.

## What the source changes

`buildBuiltIns` remains a private privileged factory. Project and global
contexts select different existing roots. Physical built-in types reuse
`IterateContextApi`; they do not introduce a public capability classification.
The root names and descriptions live in one small private table.

A durable name maps a property prefix to a fixed ordinary expression, or to
`null` to deny it. The longest matching name wins; normal inheritance remains
behind `cd` and the resolver's revision cache. A jail stops inherited access.
Call-argument matching and `@` / `...@` substitution are removed. An ordinary
confined Worker Entrypoint can adapt arguments using TypeScript. The jailed
adapter regression in `rule-snapshots.test.ts` exercises transformation,
reordering, a provided capability, and unavailable privileged roots.

Live `provide` and callback `subscribe` use the same existing pager. A live
attachment shadows a durable name while connected; releasing it reveals the
durable name. Live references and their descriptions do not become durable
configuration events. Expression and null provisions retain their existing
session-scoped rule wrapper.

Descriptions are optional documentation on the name. An optional TypeScript
`declaration` string travels with that description through `rewriteRules.list()`;
absence means unknown. Built-in declarations refer to `IterateContextApi`.
There is no runtime schema registry or claim that arbitrary JavaScript objects
can be reflected into complete types.

## One owner for durable delivery bodies

Configured subscriptions choose delivery explicitly. Live callbacks use the
pager; ordinary processors use their checkpoints; durable target subscriptions
use the private `subscriptions` facet for cursor, retry, halt/resume and fan-out
progress. Existing processor authoring and React hooks retain their shape.
The API client remains an ordinary Iterate Cap'n Web client.

The private facet keeps ranges and selected offsets. A durable retry sends
those offsets directly to the context, without a metadata reread or body
round trip. The context rereads the log, verifies the current subscription and
exact selection, derives delivery authority, resolves the stored target, and
fences the row again before invoking it. User rewrites cannot intercept this
private native channel or reach the reserved facet name.

Only selected bodies survive a target-resolution or target-call await. Their
aggregate reservation normally has an 8 MiB character budget; one legal larger
event may run alone, bounded by the RPC ceiling. Reservations end when the raw
target promise settles, even if the runner's wait has timed out. One bounded
synchronous source page can coexist with those retained bodies; the diagnostic
`targetBodyChars` measures retained target input, not total isolate memory.
There is no full-page waiter queue that serializes unrelated small deliveries.

Ephemerals have a separate, bounded one-event body path. They share an ordered
row's chain and cannot overtake an admitted durable range. Their bodies never
become persisted retry work. Busy admission does not spend a delivery attempt.
Target failures, read failures and claim recovery have bounded retries and
observable outcomes. A durable configuration high-water fences delayed pushes;
equal snapshots still admit ephemeral-only pushes without rewriting it.

## What relaxing requirements yields

Breaking stored row shapes removes compatibility branches. Old unsupported
contexts refuse reconstruction and may be explicitly recreated; this proposal
does not need a migration framework.

Replacing argument-substitution rules with ordinary adapter code removes a
second configuration language from the resolver. The tradeoff is concrete:
dynamic argument composition moves from a rewrite row into an ordinary worker
method, while named access, fixed calls, inheritance and jails remain.

Explicit delivery removes target-brand inference. A target change no longer
silently changes a subscription's lifetime or retry policy. The price is one
declared delivery choice for raw configuration; convenience APIs choose it.

The larger possible relaxation is to stop giving every arbitrary target an
automatic platform-owned durable broker. A consumer could own its forwarding,
checkpoint, retry and terminal policy as ordinary processor code. That would
remove the private durable delivery runner and its bridge, rather than merely
move them. This candidate preserves that service; deleting it would change a
guarantee and needs a real consumer replacement. Likewise, transparent proxied
WebSocket upgrades remain supported here. Neither future cut is counted as a
current deletion.

## Validation boundary

The focused runner/model tests and source/test TypeScript checks pass locally.
Workers regressions cover generation fencing, resume, replacement, private
authority, pager lifecycle, memory fairness and configuration recovery.
After reconnect, the sandbox prevents the Workers runtime from starting.
Those new runtime tests have not passed in this environment.

The draft needs green full CI, deployed slow residency rows, latency and
throughput budgets, soak results and a same-window Workers Logs comparison.
No production deployment, merge or data erase is authorized by this proposal.
