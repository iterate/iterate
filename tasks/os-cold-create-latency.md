---
state: todo
priority: medium
size: medium
tags: [os, performance, streams, secrets]
---

# Cold project-create latency: the background saga is still seconds

The caller-facing half is fixed: `create({}, { readiness: "exists" })`
returns after auth-register + directory prime + the atomic root append, and
the dashboard navigates immediately while the saga streams into the creation
checklist. This task tracks the remaining latency of the saga itself — it now
runs behind the response, but it is what the checklist user actually watches,
and the `readiness: "full"` lane (scripts, e2e) still pays it in full.

Measured on prd 2026-07-21 (`[create-timing]` via `wrangler tail os-prd`,
three admin-lane creates):

| step | warm | cold |
| --- | --- | --- |
| root-append (atomic birth batch, fresh Stream DO) | 0.5–1.5s | — |
| seed-project-api-key (Secret DO builder/create barrier) | 3.0–3.7s | — |
| wait-project-birth (both root processors through the birth frame) | 1.5–2.4s | 14s |
| whole create, ready lane | ~6–8s | ~20s |

Leads, roughly by leverage:

- **Secret create pays a full per-secret processor birth** (fresh DO + fresh
  stream + fold + cross-post to the project root) even for the born API key.
  The offset-bound-encryption barrier is a real correctness contract, so the
  win has to come from making that birth cheaper, not from skipping the wait.
- **The project birth frame serializes four sibling-birth barriers**
  (capability host, scheduler, config repo, email router) after sequential
  child-stream appends; the appends cost 1.4–1.9s each on prd.
- **Cold first-touch outliers** (14s birth) look like DO cold start plus
  durable-delivery backoff, same family as
  [[fix-cold-auth-oauth-callback-latency]].

Related: `apps/os/src/rpc-targets.ts` (`create-timing` timed steps),
`apps/os/e2e/vitest/project-create-fast-path.e2e.test.ts` (the self-driving
guarantee), tasks/raise-e2e-maxconcurrency.md.
