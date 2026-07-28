---
state: todo
priority: medium
size: medium
tags: [os, performance, streams, secrets]
---

# Cold project-create latency: the background saga is still seconds

The caller-facing half is fixed: `create({}, { waitUntilReady: false })`
returns after auth-register + directory prime + the atomic root append, and
the dashboard navigates immediately while the saga streams into the creation
checklist. This task tracks the remaining latency of the saga itself — it now
runs behind the response, but it is what the checklist user actually watches,
and the `waitUntilReady` lane (scripts, e2e) still pays it in full.

Measured on prd 2026-07-21 (`[create-timing]` via `wrangler tail os-prd`,
three admin-lane creates):

| step | warm | cold |
| --- | --- | --- |
| root-append (atomic birth batch, fresh Stream DO) | 0.5–1.5s | — |
| seed-project-api-key (Secret DO builder/create barrier) | 3.0–3.7s | — |
| wait-project-birth (both root processors through the birth frame) | 1.5–2.4s | 14s |
| whole create, ready lane | ~6–8s | ~20s |

Full-suite preview evidence on 2026-07-23 exposed the bounded tail that the
warm/cold samples missed. One config-repo processor was still completing its
terminal stream appends about 65 seconds after `Project.create` began. The
then-current 15-second public deadline abandoned that project and Vitest's
whole-test retry created a second one; the abandoned birth later hit its
60-second sibling barrier. Trace
`4d603e1afeb62f5f959255504b895244` records the exact sequence, including
`waitUntilProcessed timed out after 59517ms waiting for offset 7`.

The correctness budgets now reflect the actual nesting without changing
healthy latency: 75 seconds for sibling birth, 90 seconds for the Project
processor acknowledgement, and 100 seconds entry-to-ready. This is bounded
headroom for the original project, not a latency target. Reducing the
config-repo/stream tail below those ceilings remains the work of this task.

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
