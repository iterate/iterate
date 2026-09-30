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

## One owner for durable delivery

Configured subscriptions choose delivery explicitly. Live callbacks use the
pager; ordinary processors use their checkpoints; durable target subscriptions
keep their cursor, retry, halt/resume and fan-out state in the context's own KV.
There is no `subscriptions` facet and no bridge RPC between two platform
objects. Existing processor authoring and React hooks retain their shape. The
API client remains an ordinary Iterate Cap'n Web client.

The context owns the log, selected bodies, caller provenance, effective rules,
target resolution, cursor, and the one alarm. It reads up to 100 durable events,
filters the current row, persists the selected offsets before the call, then
rechecks the row and target authority before invocation. Fan-out starts at most
eight calls at once; later work continues from a persisted wake through the
alarm. User rewrites cannot intercept that platform work, while ordinary user
targets still resolve through the same jail and fixed-prefix rules as every
other call.

Only selected durable bodies survive a target-resolution or target-call await.
Their aggregate reservation normally has an 8 MiB character budget; one legal
larger selection may run alone within the existing RPC ceiling. Reservations
end when the actual target promise settles. One bounded synchronous source page
can coexist with those retained bodies; `targetBodyChars` measures retained
target input, not total isolate memory. There is no full-page waiter queue that
serializes unrelated small deliveries.

Ephemerals are 100 bounded offset-and-type descriptors. No ephemeral body
crosses the runner boundary or becomes persisted retry work. The context looks
each one up in its live 1 MiB ring and verifies the type before delivery. Busy
admission does not spend an attempt while its blocker is younger than 20 seconds;
after that it follows the bounded failure ladder. Target work is joined while it is actually
in flight, rather than replaying a TTL success cache: after a reset or eviction
the remaining gap is deliberately at-least-once, not a promise of deduplication.

Attempts have a 20-second wait deadline; the raw call retains its bodies until
it settles, and a context reset does not restart the attempt count.
The maximum-attempt check happens before each new call, so a call that keeps
resetting its host reaches the existing terminal outcome rather than retrying
forever. Persisted wake and cursor state recover a row after a commit or a
retry; a row that consumes no event does not create extra work. The context URL
is configured explicitly through `urls.os`, not reconstructed from a request.

The resolver keeps longest-prefix lookup, its prototype cache, inheritance, and
jail fences. These are implementation details beneath `itx`, not another public
capability taxonomy.

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

The native context-cursor work has 13 focused Workers regressions and 41 SDK
model tests passing. They cover the new ownership and cursor rules; they do not
replace full runtime validation. The current full root result has 2,301 passing
tests, 14 expected failures, and one older missing-origin fixture failure under
repair. It is not green yet.

The published 9c preview still has 19 E2E failures. Those failures and the
later native work are separate checkpoints; neither is evidence that the native
source is final. Latency, browser, soak, residency, and log evidence must be
read against the eventual tested head rather than carried forward from a draft.

The twelfth actual Opus review finds the context-owned direction smaller and
better aligned with authority, but identifies missing persisted recovery,
reset-bounded retries, birth-alarm writes, cold fan-out wake ordering, and
old-facet migration checks. The source now includes those fixes and the focused Worker probes; full
deployed validation still remains required.

The draft needs green full CI, deployed slow residency rows, latency and
throughput budgets, soak results and a same-window Workers Logs comparison.
Its measured runtime is **18,128 core lines plus 7,614 SDK lines = 25,742**,
versus main's **18,806 plus 6,814 = 25,620**. It is still **122 lines larger**;
moving responsibility does not yet achieve the requested reduction. No
production deployment, merge or data erase is authorized by this proposal.
