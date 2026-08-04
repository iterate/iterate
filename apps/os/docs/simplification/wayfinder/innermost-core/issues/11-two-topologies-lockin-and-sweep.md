# 11 — LOCK the two-topology decision + sweep what it simplifies

Type: task
Status: resolved
Blocked by: —

Jonas (2026-08-03): "the only two deployment topologies we should have for right this second are self-host all
workers OR Iterate host all workers. Iterate-host just has one extra: our product worker. They differ only in
config. Data residency → bring your own streams / repos (override the stream/repos collection RpcTarget).
Let's actually just lock this in. It simplifies a lot of stuff — go through our docs and see what it
simplifies."

## The decision (D11)

- **Topology A — self-host all workers** (you run project + control-plane + MCP; no product).
- **Topology B — Iterate hosts all workers** = A + **one outer product worker**.
- Differ **only in config**. No mixed/cross-account topology **for now**. No cross-account capnweb dial, no
  connection-holder DO, no BYO-account-per-project **for now**.
- **Data residency** = per-capability provider override (BYO stream / BYO repo = override that collection's
  RpcTarget), NOT a deployment axis.

## Tasks

1. Add an ADR (0035) locking this, marking what it **supersedes/defers**.
2. Sweep the wayfinder docs + `DECISIONS.md` + `topologies-and-axes.md` + `deployment-topologies.md` for
   everything the two-topology lock simplifies, defers, or removes. (subagent sweep — see Answer.)

## Answer

**Locked as ADR 0035** (`../../DECISIONS.md`). Docs sweep (subagent) found the full impact:

- **SUPERSEDED (big simplifications):** ADR 0006 (level-2 transit), 0007 (always-a-billing-relationship),
  0027 (BYO-account-per-project); the **four archetypes / lattice / Level-2** framings in
  `topologies-and-axes.md`, `CONTEXT.md`, `MAP.md`.
- **CONTRADICTED:** 0017 "egress always flows through the control plane" → restored clean-room direct-`fetch`
  for self-host; `control-plane-and-product.md` §4.
- **DEFERRED:** 0008 (BYO API-key), 0009 (pinned cross-account session), 0010 (cross-account provisioning),
  0013 (home-assistant _mixed topology_; Pi-as-provider fragment survives), remote legs of 0001/0014/0034
  (HTTP `/serve` dial), deployment-topology 4.
- **SIMPLIFIED:** 0023 (`pnpm dev` → full-stack only), 0022 (MCP battery → two config variants), 0034/0001/
  0014 (same-account legs hold, cross-account legs drop).
- **STILL HOLD:** 0020/0025/0031 (routing + reserved CP host), 0032/0033 (auth worker + directory), 0021
  (presence = "is the product worker mounted?"), 0028/0012.
- **REFRAMED:** 0030 / `control-plane-and-product.md` — product is a separate outer worker (already revised by
  jam §1).

**Tension resolved in ADR 0035:** deferred = the mixed _worker-deployment_ boundary (project workers in a
different CF account than the CP, joined by a standing capnweb session). NOT deferred = an external capability
provider (Pi/browser/device) **dialing INTO** a deployment via the wake socket — orthogonal to worker
placement, works in both topologies. So "BYO streams via a Pi" holds (provider dials in); the outbound
connection-holder DO (§8/D10) is the deferred piece.

**Net:** cross-account disappears for now (→ two co-located config-only topologies); egress + billing demote
to userspace/optional; data residency becomes a capability override, not a deployment axis.
