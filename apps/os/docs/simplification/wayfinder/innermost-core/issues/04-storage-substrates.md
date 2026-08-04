# 04 — Storage substrates: stream / repo / KV / R2, and the event-sourcing law

Type: research
Status: open
Blocked by: —

Jonas: event-sourcing is "pretty much a law" (organism = one ordered event log → structured into streams for
scale → FP + stream processors). BUT "Stream and Repo, and actually KV and R2 [are] two other storage
substrates" that "will probably form a core part of a project, provided by the control plane."

## The reconciliation to verify

- **The law governs LOGIC.** The organism's _state-and-reasoning_ is event-sourced: streams (per-stream total
  order) + stream processors (pure fold + side effects). This is the substrate for anything with _behavior_.
- **KV / R2 / repo are storage CAPABILITIES**, not the reasoning substrate — they're tools the logic uses
  (KV = fast lookups/cache; R2 = blobs; repo = versioned files). They're provided into a project like any
  capability, possibly by the control plane (a project's KV namespace / R2 bucket).
- So: **domain objects (event-log ⊕ fold) carry logic; KV/R2 are non-logic storage capabilities.** A repo is
  interesting — it may be a domain object (git as an event log of commits) OR a storage capability. TBD.

## Questions

- Is "logic is event-sourced; blobs/lookups are KV/R2 capabilities" the right line? Where does a **secret**
  fall — event-sourced domain object, or a KV row? (§9 Q2 asked this; likely a small domain object because
  provenance/rotation is behavior.)
- Are KV/R2 **provided by the control plane** (so a project's storage lives in the control plane's account /
  the user's BYO account) — i.e. storage location is a deployment axis, like compute?
