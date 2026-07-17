---
state: todo
priority: medium
size: small
dependsOn: []
tags: [os, itx, validation, dx]
---

# Reject malformed create() inputs at the door instead of hanging or half-birthing

Two instances of the same gap, both observed in the wild:

1. `itx.projects.create({ name: "…" })` (wrong key — the contract wants
   `slug`) is not rejected; the call proceeds and hangs the full 60s
   ready-wait, looking EXACTLY like a broken deployment (this burned an hour
   of prd bisection on 2026-07-17 after #2048's merge).
2. `agents.get("/agents/onboarding").create({})` — a prompt-less create on a
   path whose birth batch is owned by product code — currently births a
   stand-in agent with no system prompt. Clients (dashboard chat route, chat
   TUI) each carry the correct birth batch, but the server accepts anything.

## What to do

- Strict input validation on `projects.create` (unknown keys / missing slug →
  immediate contract error naming the field).
- Server-side policy for server-born agent paths: reject or default-fill
  prompt-less `create({})` where the platform owns the birth batch (this was
  the thermo review's "code judo (a)" on #2063 — it deletes the client-side
  special-casing in the dashboard route and the TUI outright).

Both are door checks: fail fast with a nameable error, never a timeout that
impersonates an outage.
