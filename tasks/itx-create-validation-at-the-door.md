---
state: todo
priority: medium
size: small
dependsOn: []
tags: [os, itx, validation, dx]
---

# Reject malformed projects.create() inputs at the door instead of hanging

One instance was observed in the wild:

`itx.projects.create({ name: "…" })` (wrong key — the contract wants `slug`)
is not rejected; the call proceeds and hangs the full 60s ready-wait, looking
EXACTLY like a broken deployment (this burned an hour of prd bisection on
2026-07-17 after #2048's merge).

## What to do

- Strict input validation on `projects.create` (unknown keys / missing slug →
  immediate contract error naming the field).

This is a door check: fail fast with a nameable error, never a timeout that
impersonates an outage.
