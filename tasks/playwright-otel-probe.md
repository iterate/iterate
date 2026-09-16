---
status: in-progress
size: small
---

# Prove Playwright-to-Cloudflare trace propagation

The research is complete; the live experiment has not started. This branch will hold a small reproducible probe and its evidence. No PR; no changes to the product CI workflow or Vitest.

## Request and assumptions

Prove how a Playwright test can sit below a CI workflow/job/step and above its HTTP requests, Cloudflare Worker, and Durable Object calls. In particular, determine whether our preview account can enable native incoming trace propagation. Direct isolated preview-account deployment is authorized. Do not use a shared preview slot or production.

- [ ] Deploy a small synthetic Worker with native tracing and a stateless Durable Object.
- [ ] Attempt `observability.traces.propagation_policy = accept` on that Worker; record the actual API outcome.
- [ ] Run isolated Playwright tests with explicit trace context, including concurrent tests and retry attribution where useful.
- [ ] Inspect recorded trace IDs and parent IDs, distinguishing native joins from mere correlation.
- [ ] Document what works, what is gated, and the smallest useful next step.
- [ ] Leave the probe inert, with no alarms, scheduled work, external integrations, or stored user data.

## Implementation log

The Cloudflare API documents incoming propagation as an account-gated feature. Existing Worker settings did not answer whether the account has it; a fresh isolated deployment is needed.

Session: `01a09f64-ea4e-7c61-ab0a-c15eb65df3bc`.
