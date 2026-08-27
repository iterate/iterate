---
status: ready
size: small
---

# Unquarantine the agent-script-reuse demo spec in CI

The first test in `specs/agent-script-reuse.spec.ts` ("a repeat request
reuses the previous turn's journaled script…") is skipped in CI. It passes
locally every run (~20s) but fails the preview lane repeatedly: on a cold
preview deployment each intercepted agent turn costs 40–70s (the sibling
fake-model spec needs ~2 minutes for three trivial turns), and this test's
warm-up turn + heavyweight factorization turn + snippet-opening cannot fit
the lane budgets. Durable-object revivals also drop the spec's session-bound
`ai.intercept` handler mid-turn ("No AI interceptor installed").

The second test in the same file (typed returns through the gate) exercises
the same reuse mechanism and DOES pass the preview lane, so CI coverage of
the feature remains.

Unquarantine when:

- [ ] `ai.intercept` survives durable-object revivals (see the intercept
  revival-resilience task), and
- [ ] first-intercepted-turn latency on a fresh deployment is bounded (the
  35–65s platform churn observed in preview journals), or the preview lane
  warms deployments before specs run.

Then remove the `test.skip` gate and this task.
