# Playwright → Cloudflare tracing: live proof

Tested 16 September 2026. **The Playwright part works. Native Cloudflare joining is blocked by an account feature, and concurrent calls to a shared DO exposed a separate trace-attribution defect.**

No PR. No product workflow changes. No Vitest work. The synthetic Worker lives in the preview account, outside every shared preview slot. Its public and version-preview endpoints are disabled after the experiment. It has no alarms, cron, external services, or storage writes.

## What ran

An actual OpenTelemetry JS SDK exported OTLP/HTTP JSON from a local launcher and Playwright worker processes into a local receiver. This is real OTel data, not a conversion of log timestamps. The workflow/job labels below represent local proof spans, **not an actual Depot run**:

```text
local workflow proof
└─ local shard job proof
   └─ playwright command
      ├─ browser test, attempt 0
      │  └─ browser HTTP request
      ├─ API test, attempt 0 [intentional assertion failure]
      │  └─ API HTTP request
      └─ API test, attempt 1 [passed]
         └─ API HTTP request
```

Both initial tests overlapped on separate Playwright workers. All nine spans share trace ID `ba98d7c2156c5f54ee4672268b26d265`; request parents match their test attempts. The retry has the same test ID and a different span ID. The failed attempt was exported before Playwright replaced its worker.

The browser request came from real headless Chromium. API requests used Playwright's `APIRequestContext`. Each sent its **request span**, not merely its test span, in `traceparent`.

## Cloudflare boundary

On the isolated Worker, the API rejected:

```json
{ "observability": { "traces": { "propagation_policy": "accept" } } }
```

with HTTP **403**, code **100342**:

> propagation_policy requires the trace propagation feature to be enabled.

That is the “feature flag”: an account capability, not a Playwright flag or a TypeScript toggle. Only the preview account was tested. No documented self-service switch was found.

The Worker received every exact `traceparent`, but its native trace used a different trace ID and a root with no parent. Example:

| Value                   | Recorded ID                        |
| ----------------------- | ---------------------------------- |
| OTel client trace       | `ba98d7c2156c5f54ee4672268b26d265` |
| Browser request span    | `6ab5c48e16469fde`                 |
| Native Cloudflare trace | `a3d2835c34ed1d30049ad64e13c9043b` |
| Native root span        | `cf8eba4c3f805f1e`, no parent      |

The header is recorded as a probe attribute solely to establish correlation. **No trace IDs or parent IDs were rewritten to make the two trees appear joined.**

## Unexpected shared-DO attribution issue

The first run caught the API request's DO span below the browser request's native trace. A second deployment added only a choice of object name so we could control sharing:

| Control                                  | Calls | DO span attributed to another request's trace |
| ---------------------------------------- | ----: | --------------------------------------------: |
| Concurrent requests, same fresh DO       |     8 |                                         **7** |
| Concurrent requests, different fresh DOs |     8 |                                             0 |
| Sequential requests, same fresh DO       |     8 |                                             0 |

Every response echoed the correct input and passed assertions. The Worker and DO custom spans both recorded the incoming header, so we can match the same logical call independently of Cloudflare's native trace IDs. This is evidence of a native tracing attribution defect or limitation, **not evidence of product data crossing between requests**. We have not diagnosed Cloudflare's internal cause.

The Worker is intentionally tiny: `fetch → tracing.enterSpan → DO.ping → tracing.enterSpan`. No application context store, mutable request globals, third-party tracing SDK, or Cap'n Web sits inside it.

## What this means for the real integration

1. **Proceed with Playwright instrumentation.** Give each workflow attempt an identity, propagate its parent context to jobs and command steps, and create a fresh test-attempt context inside each Playwright worker. Export completed spans promptly so failures/retries survive process replacement. A reporter alone runs in the wrong process to establish request context.
2. **Ask Cloudflare for incoming trace propagation on the preview account**, and supply this shared-DO repro alongside that request. Enabling the flag by itself will not establish that parallel-test attribution is sound.
3. **Choose one trace store that accepts CI spans and Cloudflare exports.** This probe proves SDK → local OTLP receiver only. Cloudflare supports exporting native telemetry; no supported generic external-span ingestion endpoint into its own viewer was found. Native export to a common receiver remains untested here.
4. After those checks, prove one real OS browser/ITX flow, then wire the full workflow. This experiment exercises HTTP and native DO RPC; **WebSocket/Cap'n Web per-call propagation remains untested**. A WebSocket handshake is not a separate parent for every subsequent RPC.

For browser header injection the probe uses a route restricted to its own origin. Playwright routing changes cache behavior; this is not a proposed blanket production fixture. Browser events can provide request timing separately from how headers are injected.

## Evidence and reproduction

- `evidence/playwright-otlp.json`: original SDK OTLP payloads.
- `evidence/otel.json`: native span source records returned by Cloudflare's `otel` query dataset; query/user metadata omitted.
- `evidence/audit.json`: checked local hierarchy and the three request-to-native correlations, including the misattributed DO span.
- `evidence/controls-audit.json`: all 24 control comparisons.
- `evidence/propagation.json`: original 403 response.
- `evidence/disabled.json`: API confirmation that both public URL types are disabled.

From the worktree root, with the repo's normal dependencies installed:

```sh
pnpm --dir experiments/playwright-otel install --ignore-workspace --ignore-scripts
# The stored evidence can be audited offline:
pnpm exec trpc-cli experiments/playwright-otel/audit.ts audit
pnpm exec trpc-cli experiments/playwright-otel/audit.ts audit-controls
```

To repeat the live probe, `_shared/preview` Doppler access is required. `deploy` provisions the uniquely named Worker for the first time and saves an ignored local credential. On this worktree the Worker already exists; use `update-worker` to deploy this source and re-enable its endpoint with the existing local credential. Choose a new Worker name before first deployment from another checkout. **New runs overwrite evidence files; preserve any old evidence you want first.**

```sh
pnpm exec trpc-cli experiments/playwright-otel/probe.ts update-worker
pnpm exec trpc-cli experiments/playwright-otel/probe.ts propagation
pnpm exec trpc-cli experiments/playwright-otel/run.ts run
pnpm exec playwright test controls.spec.ts --config experiments/playwright-otel/playwright.config.ts
# Native telemetry is eventually available; retry this bounded query after ingestion.
pnpm exec trpc-cli experiments/playwright-otel/probe.ts query --dataset otel --minutes 15
pnpm exec trpc-cli experiments/playwright-otel/audit.ts audit
pnpm exec trpc-cli experiments/playwright-otel/audit.ts audit-controls
pnpm exec trpc-cli experiments/playwright-otel/probe.ts disable
```

`probe.spec.ts` intentionally reports one flaky test: it fails an assertion once, then passes. The three control specs all passed without retries. The audit asserts complete evidence and reports attribution results; it does not assert that the platform defect must remain broken forever. Its external-propagation assertion currently captures the observed disabled feature and should change when that feature is enabled.

References: [propagation policy API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/), [native custom spans](https://developers.cloudflare.com/workers/observability/traces/custom-spans/), [OTel export](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/), [current tracing limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/).

Session: `01a09f64-ea4e-7c61-ab0a-c15eb65df3bc`.
