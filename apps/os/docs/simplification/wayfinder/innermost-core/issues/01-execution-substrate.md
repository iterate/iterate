# 01 — Where does running code sit? (the execution substrate)

Type: grilling
Status: open
Blocked by: —

Jonas: "capabilities are only relevant if you can run stuff in the context of the capabilities." A capability
tree nobody calls is inert. So there must be an **execution substrate** paired with the capability substrate.

## The claim to grill

**The innermost pairing is `(context, execution)`** — a context is _where capabilities live_; execution is
_code running with a context bound_ (e.g. `env.ITX`) that both **consumes** capabilities (calls `itx.*`) and
can **provide** them (register a capability, emit events). Execution + provision are dual: the wake-on-call
"provider" (a Pi) is just _running code that provides a capability and can be called back_.

Execution physically appears in ≥3 places today, all holding a context:

1. **Dynamic worker** (Worker Loader): the config worker / user code, bound to `env.ITX`.
2. **Stream processor**: code inside a domain-object DO folding events + doing side effects, with itx access.
3. **External provider**: a Pi/browser/CLI running code that dials in, provides a capability, and calls back.

So "running code" is NOT one DO — it's _any code holding a context stub_. A **project = a context + the
ability to run code bound to it.** Ties to the organism theory: event log = memory; running code =
metabolism (reads the log, calls capabilities, appends new events).

## Questions

- Is `(context, execution)` the right framing, or is execution itself a capability the context provides
  (`itx.workers.run(...)`)? (Probably both — running code is reachable AS a capability _and_ is what consumes
  capabilities.)
- Does the kernel need an explicit "execution" primitive, or is it always "a worker/DO holding env.ITX"?
