# Round 11: context-owned durable cursor review

**Review source:** `/tmp/core-simplification-opus/round-11-root.result.md`  
**Model:** Claude Opus 5.5, xhigh thinking; 47,689 thinking tokens, 55,738 output tokens, and 569,893 ms API duration.  
**Method:** read-only source review; no tests run.

The review did **not** read the supplied frozen `round-11-source` tree. Its
read tool was confined to the active mutable worktree
`/private/tmp/iterate-core-simplification-resumed`, reported at `ef90c40ba`.
It could not verify that tree against `MANIFEST.sha256`, and direct reads of the
facet, bridge, and SDK runner from the supplied tree were denied. Treat this as
a design review of a moving source tree, not an immutable implementation audit.

Its proposed simplification is to keep trusted durable runners and their
cursors in the context that owns the log, bodies, caller provenance, effective
rules, and target invocation. The separate `subscriptions` facet and bridge
would then be deletable. This does not change the public `itx` surface, Cap'n
Web target authoring, or ordinary user facets.

The review accepts that direction only if the context replaces the concrete
recovery work the facet currently supplies:

- hold an existing residency pin for the actual target promise;
- persist an owed mark in each cursor for the gap from commit to admission;
- record cursor and terminal outcomes from the real promise, rather than a
  timeout race;
- postpone delivery writes until facet birth initialization is complete;
- derive alarm deadlines from cursors, retain bounded fan-out concurrency, and
  prove eviction, deploy, CPU, subrequest, and old-facet behaviour.

It also identifies the tradeoff plainly: moving runners home removes two RPC
hops and duplicate configuration/fence/claim machinery, but concentrates
subrequests, CPU, and target-body reservations in context invocations. A
resident or hung target must therefore be proven bounded without recreating a
second keepalive or claim layer.

The review is promising design evidence. It is not evidence that the native
implementation exists or passes local, preview, latency, residency, or soak
validation. See [the findings report](../findings.md#published-preview-9c-and-round-11)
for the current published-run status.
