# Build plan — the clean-room lab (step by step)

No "phases" — a running order of steps, each proving one thing. **Streams come late**: a lot proves out
without the heavy streams machinery (ADR 0026). Standing constraint: **no `rpc-targets` god-object**
(ADR 0018) — capabilities are self-contained; the entangled ones (repo, capability host, dynamic-worker
building) get **re-implemented, not imported** (confirmed).

## Prove WITHOUT streams first

1. **Ingress routing table (KV).** ✅ **BUILT (2026-07-30).** `apps/kernel/src/routing.ts` — a `Routing`
   (`lookup`/`map`/`unmap`) resolving **config routes first, then `ROUTING_KV`** (`route:<host>` keys),
   consulted in `kernel.ts` ingress **before** the `<slug>.<hostBase>` convention. Write path =
   `Project.mapHostname(host, app?)` over the ITX tree. Bound in dev/selfhost; config `routes` added to
   the test profile. Proven: 6 unit tests + an e2e where `myapp.test` (a config route, off the hostBase)
   serves project `alice` with confinement intact, while an unmapped off-base host still 404s. Unlocks
   custom domains + single-project self-host (a real hostname, no wildcard base). _Config + KV are the
   control plane's two inputs (ADR 0025)._
2. **The deployment permutations** (topologies-and-axes.md + phase-0-runbook.md). Stand up each archetype
   — iterate-hosted · project worker in your CF account · project worker on your box · self-hosted — and
   **BYO-account-per-project at create time** (ADR 0027). Prove ingress + auth (walled/wide-open) +
   confinement across our account / a separate account (Jonas personal `05958…`) / Miniflare.
3. **MCP everywhere** (ADR 0022/0029). A kernel-reserved `/mcp` route (like `/api`); auth via the wall
   (Access, or anonymous when unset); config-driven MCP base URL. Prove unauth **and** auth per topology,
   incl. Miniflare-local. **Enforce "emerge with a project"** — never return a project-less MCP session.
4. **Arbitrary code execution (ITX scripts).** Add the ability to run ITX scripts in the lab soon — it
   proves a lot at once (the userspace project entrypoint executing against the ITX tree). _(Jonas.)_
5. **Ingress/egress HTTP paths + secret substitution at BOTH levels.** Prove the egress door substitutes
   secrets at the **project** level and the **control-plane** level (the two-hop egress), with the
   project never seeing the raw value.
6. **First-party integrations — Slack + Exa/Parallel** (concrete). Slack OAuth receiver at the
   control-plane host; Exa/Parallel = first-party API keys we let customers use, metered. Prove the
   control plane **intercepts** Exa/Parallel egress and can account for spend (a control-plane billing DO —
   prove-we-could, not urgent; ADR 0030 says this is the _iterate-product layer_, off in self-host).
7. **How a project gets its control-plane capabilities.** The composition question: capabilities handed
   via **config + props** (leaning) and/or birth events (TBD). If config+props, **no streams needed** to
   prove it. This is where the capability tree gets composed — and where "presence depends on the
   environment" becomes concrete (Slack/Exa present iff the control plane wired them).

## Then, and only then — streams

8. **Streams** (reuse the engine verbatim + a thin kernel-owned stream DO; wire into the ITX tree). The
   heavy machinery; deferred until 1–7 (esp. MCP) are proven. If capability composition (step 7) turns
   out to need birth _events_, that's the moment streams become load-bearing.

## Re-implemented natively, not imported (as they come up)

Repo, the capability host (mounting + event-shadowing, builtins-win), dynamic-worker building. Welded to
`rpc-targets` today (reuse-feasibility.md) — rebuilt clean in the lab.

## Not yet

Data migration · multi-user self-host · versioning/upgrades · the daily 3p-cost job (iterate-product
layer, off in self-host).
