---
status: complete
size: small
---

# Prove Playwright-to-Cloudflare trace propagation

The live proof is complete. Playwright emitted correctly parented OTel request spans across concurrent tests and a retry. Cloudflare rejected incoming propagation (403/100342); a separate control reproduced DO trace misattribution in 7/8 shared concurrent calls. The probe endpoints are disabled. No PR or product CI changes.

## Request and assumptions

Prove how a Playwright test can sit below a CI workflow/job/step and above its HTTP requests, Cloudflare Worker, and Durable Object calls. In particular, determine whether our preview account can enable native incoming trace propagation. Direct isolated preview-account deployment is authorized. Do not use a shared preview slot or production.

- [x] Deploy a small synthetic Worker with native tracing and a stateless Durable Object. *`experiments/playwright-otel/worker.js`; preview account only.*
- [x] Attempt `observability.traces.propagation_policy = accept` on that Worker; record the actual API outcome. *`evidence/propagation.json`: feature-gated 403/100342.*
- [x] Run isolated Playwright tests with explicit trace context, including concurrent tests and retry attribution where useful. *`probe.spec.ts`, real Chromium/API requests, nine SDK spans.*
- [x] Inspect recorded trace IDs and parent IDs, distinguishing native joins from mere correlation. *`audit.ts` and `evidence/*audit.json`; local parenting works, native propagation is absent, shared DO attribution is defective.*
- [x] Document what works, what is gated, and the smallest useful next step. *Experiment README includes controls, limitations and reproduction commands.*
- [x] Leave the probe inert, with no alarms, scheduled work, external integrations, or stored user data. *`evidence/disabled.json` confirms workers.dev and version previews disabled; source has no storage writes or timers.*

## Implementation log

The Cloudflare API documents incoming propagation as an account-gated feature. Existing Worker settings did not answer whether the account has it; a fresh isolated deployment is needed.

16 September: native trace audit caught a DO custom span under another request's trace. Controls compared eight concurrent calls to a shared fresh DO (seven misattributed), eight concurrent calls to separate fresh DOs (zero), and eight sequential calls to one fresh DO (zero). All 24 product responses were correct. Cloudflare enablement and attribution need follow-up; no external issue or support message was sent.

Session: `01a09f64-ea4e-7c61-ab0a-c15eb65df3bc`.
