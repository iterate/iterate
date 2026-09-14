---
name: fix-stream
description: Diagnose a reported OS agent-stream failure from its journal and reproduce it with the current processor harness.
---

# Fix an agent stream

A URL `/projects/<slug>/agents/streams/agents/<id>` identifies stream `/agents/<id>`. Resolve the project slug to its `prj_…` ID before using the CLI's `--context`. Keep exported journals private until reviewed for credentials, user content and expiring URLs.

## Capture and interpret

Use `pnpm cli itx run --help` from `apps/os`; select the environment explicitly through Doppler. The script file runs with `itx` in scope and returns its result as JSON. `--context` takes a project ID, not a slug. The [CLI implementation](../../../apps/os/scripts/itx.ts) owns these options.

Page `itx.streams.get(path).getEvents({ afterOffset, limit: 500 })` until exhausted. Advance from the last returned offset; preserve original offsets, event order and idempotency keys. Use `pnpm --silent` when capturing stdout rather than heuristically stripping JSON-looking text.

Locate the reported user-visible failure using `agents/context-added`, `agents/web-message-sent`, request offsets and surrounding outcomes. Keep full event names from the journal; compare them with the current [agent contract](../../../apps/os/src/domains/agents/agent-processor-contract.ts). A recovered provider error is not necessarily the user's complaint.

## Reproduce with current code

Start with [agent-processor.test.ts](../../../apps/os/src/domains/agents/agent-processor.test.ts) and the [processor testing guide](../../../docs/writing-stream-processors.md#testing-every-failure-above-is-a-few-lines-of-plain-node). They use `makeProcessorHarness` from `iterate/processors/testing`, backed by the real runner and memory durability substrate. The harness source is [testing.ts](../../../packages/iterate/src/processors/testing.ts).

- Build reachable state through the harness lifecycle. `h.append(...)` drives delivery; raw `h.stream.append(...)` commits without delivery. `h.crash()` detaches an incarnation; a new append or due alarm wakes its successor.
- Use the suite's scripted transport for provider behavior. Preserve the real failure shape rather than guessing a new transport abstraction.
- Derive timing from current configuration. Do not copy a historical debounce value or removed `OpenAiWsProcessor`/`deliverNewEvents` recipe.
- Assert the missing user-visible or durable outcome after the triggering input. A timeout alone does not prove the incident was reproduced.

For journal-shaped incidents, keep a small captured-journal repro as required by [testing](../../../docs/testing.md#what-earns-a-test). Minimize only fields and events proven irrelevant; verify the minimized case fails without the fix and passes with it. Restart/replay must not re-enact historical side effects.

Run the focused test with `pnpm exec vitest run <test-file>` from `apps/os`, then the checks required for the changed code. Operational fixes also require the root engineering invariant's preview/state/telemetry proof. Report the symptom, event evidence, cause, fix and verification. Commit/push/PR actions follow the user's authorization and [PR workflow](../../../docs/pull-requests.md).
