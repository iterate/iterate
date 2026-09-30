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
There is no `subscriptions` facet or bridge RPC. Main already kept delivery
in the context; the separate facet was an intermediate candidate rejected here. Existing processor authoring and React hooks retain their shape. The
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
silently changes a subscription's lifetime. The price is one declared delivery
choice for raw configuration; convenience APIs choose it.

Every context-owned durable target now gets the same 25-attempt ladder, with
exponential retry delay capped at four hours. Relaxing different policy for
webhook and ordinary targets removes target inspection and rule-dependent
runner configuration. Ordinary targets receive ten more attempts; webhook
retry capacity is preserved. The standalone SDK runner keeps its own defaults
and overrides.

One context recovery deadline covers cold starts and in-flight drains. Removing
per-row wake reconstruction accepts recovery after a cold start on that bounded
context wake, instead of introducing another persisted wake field. Resume
acknowledgement is part of the cursor itself, so it cannot disagree with a
separate KV marker. Starting a retry consumes its previous wake, so a long
running call cannot repeatedly re-arm an already past deadline. Fan-out persists each eight-call wave before invoking any
target and writes its combined outcomes once, rather than rewriting the whole
cursor for each item. The cursor root owns the resume acknowledgement; pending
ranges, fan-out items and halt records no longer duplicate that identity. Each
call captures the current identity in memory, with generation checks on both
sides of every await. Fan-out admission uses the existing confirmed offset,
rather than another persisted counter. Retrying items no longer store the
previous attempt's error; if the final attempt is interrupted by a host reset,
the terminal receipt says it did not settle before its host restarted. Final
terminal errors remain until their receipt is acknowledged.

A cold request, including an ephemeral-only first push, drives every newly constructed durable runner, so an unrelated
wildcard row cannot clear the context's recovery alarm while a filtered row has
a persisted retry. After that one reconstruction, ephemeral commits do not drive warm fan-out rows. Empty admission
pages do not rewrite the cursor. Resume clears old ephemeral descriptors, and
row-halt receipts carry the selected source offset instead of borrowing a cause
from the first unconsumed event or an offset beyond the head.

Failure and halt receipts reach a durable target only when its consumes list
names the exact event type. This relaxes implicit wildcard delivery of the
subscription's own diagnostics and prevents a failed receipt from generating
another failed receipt forever. Explicit receipt subscriptions remain possible.

The larger possible relaxation is to stop giving every arbitrary target an
automatic platform-owned durable broker. A consumer could own its forwarding,
checkpoint, retry and terminal policy as ordinary processor code. That would
remove the automatic durable runner and the recovery policy that the context
currently supplies for arbitrary targets. This candidate preserves that service; deleting it would change a
guarantee and needs a real consumer replacement. Likewise, transparent proxied
WebSocket upgrades remain supported here. Neither future cut is counted as a
current deletion.

## Validation boundary

The runner and model suite has 51 passing tests, and the unchanged ordinary
processor engine has 64 passing tests. Three new Workers fault probes pass:
implicit failure-receipt reentry, a large retry range ending at an ephemeral
position, and terminal acknowledgement of an invalid selective resume. Existing
cold recovery, admission, halt/resume, replacement and ephemeral offset-reuse
probes remain in the full Workers suite.

The published 8d checkpoint passes the full root test command, including socket
suites: OS has 154 passing files, 2,310 passing tests and 14 existing expected
failures. Lint, typecheck, formatting and Knip pass. The new deployed-target
fixture supplies its already known OS URL alongside Doppler secrets; the
Worker, preview readiness gate and test harness share that configured origin.
The compact cursor and cold-wake repairs are being rerun on a frozen head.
Local success does not replace the deployed slow residency rows, browser specs,
latency/throughput budgets, 100-run soak and same-window Workers Logs comparison.

The published 9c preview had 19 E2E failures. Its browser and performance results
and its cancelled soak are historical evidence, not proof of this native head.
The five malformed Server Function errors were intentional 400 probes; the
133 live-stub retries and alarm recovery still require fresh comparison.

Fifteen actual Opus reviews are recorded in the findings PR. The thirteenth
review used immutable source 179629660f and identified the resume, receipt,
wake, range and fan-out persistence faults now addressed in this checkpoint.
It did not execute tests or review later source changes. The fifteenth reviewed immutable source 5eff1bf85 and found the remaining ephemeral-only cold-start wake loss, now covered by a regression that fails with the previous condition. It confirmed the generation, seek/resume, retry-bound and selected-cause paths by reading source; it did not run tests.

The tracked working count is **18,081 core lines plus 7,497 SDK lines = 25,578**,
versus main's **18,806 plus 6,814 = 25,620**. This is only **42 lines smaller**:
core fell by 725 lines while the SDK grew by 683. Restoring the existing
processor claim code removes the now single-caller `BackgroundClaims` class;
moved responsibility and deleted tests do not count as runtime deletion. This
is a real but inadequate combined reduction, and further simplification remains
part of the task. No production deployment, merge or data erase is authorized.
