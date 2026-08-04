# 03 — The 4 shells are 4 nested contexts (dissolving the entanglement)

Type: task
Status: open
Blocked by: 01, 02

Jonas: 4 layers — (1) a capability, (2) project, (3) control plane, (4) product — "all entangled in my mind."

## The claim: the entanglement IS the answer

They feel entangled because they are **the same primitive** (a **context**) at different scopes, nested by
**parent fallthrough**. Un-entangling ≠ splitting them into different ideas; it's recognizing they're ONE
idea recursively.

```
capability            ← the ATOM (what a context resolves to; not a shell)
   ▲ resolved-by
PROJECT context        parent → control-plane
   ▲ falls-through-to
CONTROL-PLANE context  parent → product        (knows about many projects = its mounts/children)
   ▲ falls-through-to
PRODUCT context        parent → config defaults (knows Slack/GitHub = its mounts)
```

- A **capability** flows DOWN (product provides Slack → control plane → project) via the same
  provide/fallthrough mechanism.
- A **call** flows UP the fallthrough chain until something resolves it (project → control-plane → product →
  constructive default), with an authorization narrowing at each hop (`02`).
- §1 "iterate product provides to the control plane" = product is the control-plane context's parent.

## Deliverable

Ratify (or break) "4 shells = 4 nested contexts + a capability atom." If it holds, the whole platform is
**one primitive (context) composed by one mechanism (parent fallthrough)** — the smallest possible core.
Depends on `01` (execution — each context must be runnable) and `02` (auth — each hop is a boundary).
