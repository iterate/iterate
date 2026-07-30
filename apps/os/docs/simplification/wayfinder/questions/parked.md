# Parked & later-round questions

Not on the active frontier. Listed so nothing is silently assumed.

## Parked (settled as "not now")

- **Data-migration mechanics** (OQ-e / D10) — copy semantics, cutover, consistency. Lattice _permits_
  moves; mechanics deferred.
- **Multi-user self-host** (OQ-b) — D2 settled _project_ isolation; whether self-host also needs
  multi-_user_ orgs (only auth.iterate.com provides today) is residual.
- **Versioning / upgrades of the bundle** (OQ-d) — self-hosters `git pull` + `pnpm deploy` (D9); how the
  edge-cached bundle _advances_ is unspecified.
- **Fully-offline no-account mode** (OQ-g) — R3b assumes a `wrangler login`; a zero-cloud mode (no CF
  account, local capabilities only) may not be worth it.

## Round 2 (blocked on round 1)

- **[06] Account-per-project** — first-class rung (via Workers-for-Platforms) or parked experiment?
  Blocked on Q01/Q02.
- **[07] Permutation matrix** — which rungs we build minimally, in what order. Blocked on Q01/Q02/Q06.
- **[08] Harness mechanics** — config profiles + per-rung e2e smokes; where experiments live. Blocked on
  Q01/Q02.

## Round 3+ (fog)

- Webhook ingress at L2: lossy synchronous relay (codex) vs short-TTL buffer (plan R7 / opus).
- Lease / fencing semantics for the held session (epochs, `runner_offline`, `Retry-After`).
- Bilateral sourcing consent (codex's manifest authorization) — only if BYO consent becomes concrete.
- Routing truth: KV-as-table vs Registry-DO-with-KV-projection.
- **What the durable log (M4) actually is** — "the log is the computer" vs streams-as-one-capability.
  The deepest fork; downstream by design.
