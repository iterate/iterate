---
status: needs-grilling
size: medium
---

# Config repo intent + worker error visibility

Two platform gaps exposed by the 2026-08-25 misha-project incident (stale SDK
pin broke agent births; the breakage was near-invisible):

1. Config repos record no provenance/intention — no "this was initialised as
   head-of-main default config template" fact, and no affordance to re-sync
   to the template's latest head.
2. Project-worker build/delivery errors are nearly invisible to the project
   owner (a subscription `lastError` field reachable only over RPC; an error
   event inside the agent's own chat).

Being fleshed out via a grill-you interview; spec lands here when it ends.
