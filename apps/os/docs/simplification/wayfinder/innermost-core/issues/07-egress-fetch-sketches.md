# 07 — Egress / fetch: a few concrete sketches

Type: prototype
Status: open
Blocked by: 05

Jonas: "egress fetch, we have to just sketch out a few different ways."

## Sketches to lay out (pick after seeing them)

1. **Egress = a provided `fetch` capability on the context** that internally knows about secrets (themselves a
   capability/domain object) and does secret-substitution + origin-pinning + metering. Keeps the innermost
   surface tiny (Jonas's musing). The project's `globalOutbound` routes to this capability.
2. **Egress = a control-plane capability** the project falls through to (project has no raw fetch; `03`
   fallthrough). Metering/first-party keys live at the control-plane hop.
3. **Egress = both** — a `fetch` capability whose _default provider is the control-plane's egress door_, with
   the secret/stream-path coupling inside the capability, not the kernel.

Cross-cut: secrets are tied to stream paths today; keep that coupling **inside** the fetch capability
(pluggable), not in the kernel (Jonas). Ties to `05` (the fetch capability's type) and `02` (egress carries
authority → re-delegation risk the red-team flagged).

## Deliverable

Three short code sketches + a recommendation. Low priority relative to 01–06 (mechanism is proven in the
fused spike; this is about _where the coupling lives_).
