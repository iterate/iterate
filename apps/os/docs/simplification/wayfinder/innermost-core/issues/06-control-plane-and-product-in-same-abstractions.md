# 06 — Control plane & product implemented in the SAME abstractions

Type: research
Status: open
Blocked by: 03, 04, 05

Jonas: "I want the control-plane source code implemented in terms of the same abstractions [streams, etc.]. I
want the product source code implemented in the same abstractions. And I want them to nest in each other
without being completely separate ideas." "I don't know how we get that."

## The claim: they're contexts, so their source IS streams + processors + provided capabilities

If control-plane and product are **contexts** (`03`) — domain objects with event-log folds (`04`) — then
their _implementation_ is the same as a project's:

- Control-plane "which projects exist / ingress routes / directory" = a **fold over a directory stream**;
  its capabilities (`egress`, project-creation, routing) are provided down to projects.
- Product "Slack / GitHub" = **stream processors** (webhook events → fold) + **provided capabilities** mounted
  onto the control plane, flowing down to projects.
- "Nesting without separation" = **parent fallthrough** (product ← control-plane ← project). Same primitive,
  nested. Not separate ideas — the same ideas at different scopes.

So the kernel defines _one_ set of abstractions (context, stream, processor, capability, type); the control
plane, the product, AND a user project are all _written against that one set_. The difference is only which
mounts + parent each has.

## Deliverable

Show a concrete "hello world" of the control plane and the product each expressed as a context + a stream
processor + provided capabilities — enough to confirm the nesting is real and not hand-waved. Depends on the
capability definition (`05`), the storage line (`04`), and the nested-context ratification (`03`).
