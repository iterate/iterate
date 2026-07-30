# Deployment archetypes × axes — concrete

**One worker for now** (split later), with two **logical** roles:

- **Control plane** = the **network edge** (ingress _and_ egress) + auth + routing + webhook ingress.
- **Project worker** = **`ProjectWorkerEntrypoint`**, a props-parameterised `WorkerEntrypoint` class =
  **compute** (runs the dynamic/userspace workers) + **data** (the DOs) + its **own local bindings**.

They're one worker because a dynamic Worker Loader binds its guest's `env.ITX` to a **loopback**
entrypoint via `ctx.exports`, and loopback bindings live within a single worker — so the loader and the
`ProjectWorkerEntrypoint` must be co-located. The two roles stay logically separate (clean seam = the
ITX/`authenticate` interface), so a later split into a separate network-edge worker is cheap.

"Self-hosting" is just: **who runs the control plane, where the project worker runs, and how they connect.**

## What the control plane is for (answers "what do I need it for if I run everything myself?")

1. **Authentication** — the wall (verify the injected JWT).
2. **Ingress routing** — public hostname → project.
3. **Webhook ingress** — GitHub / Slack / etc. land here, then get routed to the project.
4. **Egress** — the outbound network path goes through the control plane in **all** cases. The project
   worker never touches the public internet directly; its `globalOutbound` forwards to the control
   plane's egress door. It's just _whose_ control plane — ours or yours.

So the network edge (both directions) is always a control plane; only _which_ control plane changes.

## The one reach rule (no dial-out)

The control plane reaches a project worker by **exactly one of two mechanisms**:

- **Workers RPC to a loopback binding** — project worker **co-located** with the CP (same account).
- **capnweb over HTTP** — project worker **remote**: a **public hostname** we connect to.

No NAT dial-out. A homelab behind NAT makes _itself_ findable (a tunnel) and presents a public hostname.

## The spectrum (four archetypes)

The two **ends** are structurally identical — CP worker + project worker co-located in one account,
loopback binding — differing only by **owner**. The two **middles** are "your project worker, our
control plane, reached by capnweb/HTTP."

- **iterate-hosted** — **we** run CP + project worker (co-located, loopback). Our account, our data.
  The clean room today.
- **project worker · your CF account** — **you** run the project worker in your Cloudflare account;
  **our** control plane reaches it by capnweb/HTTP. Your account, your data.
- **project worker · your box** — **you** run the project worker on a local box (`pnpm dev`/Miniflare),
  made findable by a tunnel; **our** control plane reaches it by capnweb/HTTP. Data never leaves the box.
- **self-hosted** — **you** run CP **and** project worker (co-located, loopback), in your account or on
  your box. Your bundle contains the entrypoint. It's iterate-hosted, but it's _you_. The Pi wide-open
  floor is self-hosted-on-a-box.

## The table

| axis                                                                           | **iterate-hosted**       | **project worker · your CF account** | **project worker · your box**                                   | **self-hosted**               |
| ------------------------------------------------------------------------------ | ------------------------ | ------------------------------------ | --------------------------------------------------------------- | ----------------------------- |
| **control plane**                                                              | ours                     | ours                                 | ours                                                            | **yours**                     |
| **project worker runs**                                                        | our account (co-located) | your CF account                      | your box (Miniflare + tunnel)                                   | your account/box (co-located) |
| **CP → project worker**                                                        | RPC **loopback**         | **capnweb / HTTP**                   | **capnweb / HTTP**                                              | RPC **loopback**              |
| **`env.AI` / `env.ARTIFACTS`** (need a CF account — **never local**, ADR 0028) | our account              | your account                         | **a CF account** (the `wrangler login` account — _not_ the box) | your account                  |
| **DOs / KV**                                                                   | our account              | your account                         | **your box** (Miniflare-local)                                  | your account/box              |
| **egress leaves via**                                                          | our CP                   | our CP                               | our CP                                                          | your CP                       |

**Bindings always follow the project worker** — for now `env.AI` and `env.ARTIFACTS` come from whatever
account the project worker runs in. No per-capability sourcing yet (deferred; see below).

## The axes that actually vary

1. **Who runs the control plane** — us (middle three) or you (self-hosted).
2. **Where the project worker runs** — co-located (loopback) or remote (capnweb/HTTP).
3. _(deferred)_ **Where each binding resolves** — a later knob; today bindings follow the project worker.

## Decisions to lock (concrete)

1. **Runner = `ProjectWorkerEntrypoint`** — one props-parameterised class. _(Jonas — locked.)_
2. **One worker for now** — loader + entrypoint must be co-located (loopback `ctx.exports`); the two
   roles are logical, split deferred. _(Jonas — locked.)_
3. **Control plane = auth + ingress routing + webhook ingress + egress.** _(Jonas's list — locked.)_
4. **Egress always goes through the control plane** — the project worker's `globalOutbound` forwards to
   the CP egress door (loopback when co-located, capnweb/HTTP when remote); the project worker never
   hits the public internet directly. _(locked.)_ — _change from the clean room, where `globalOutbound`
   is the project entrypoint's own `fetch`._
5. **Reach = loopback binding OR capnweb over HTTP.** No dial-out. _(locked.)_
6. **Bindings follow the project worker for now** — `env.AI`/`env.ARTIFACTS` from its own account;
   per-capability sourcing (config-shadowing) is **deferred**. _(Jonas — locked for the start.)_
7. **Props.** `projectId`, `path`, `purpose`; co-located → loopback `ctx.exports`, remote → wrangler
   `env` + the `authenticate()` handshake. _(sources map dropped for now per #6.)_
8. **Event-shadowing stays fallback-only** — `provideCapability` adds undeclared names; builtins win.

## Deferred (was on the frontier, now parked at Jonas's call)

- **Per-capability sourcing / config-shadowing** (the `ai`-from-our-account knob). Storage-shaped vs
  service-shaped dichotomy still holds when we return to it; not needed to stand up the lab.
