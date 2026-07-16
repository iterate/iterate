---
status: implemented, pending apps/mobile merge
size: medium
---

# mobile-examples-runner

**Status summary:** the `apps/os` half is done and live-e2e-proven (a shared `run-example.ts` promoted from e2e-only test support to product source, plus a new `egress-rules-configured` example). The `apps/mobile` half (the actual runner screen) is blocked on `apps/mobile` existing on `main` — it currently only exists on the not-yet-merged `os-ios-app` branch (PR #2044). Once that merges and this branch pulls `main`, the mobile screen is the remaining work.

## Why

From a conversation while testing PR #2044's human-in-the-loop egress approvals on-device: testing that feature required seeding an egress hold rule via `pnpm cli itx run` from a laptop before anything showed up to approve on the phone. Since **every mobile feature is being built by agents**, it needs to be **fully testable from the phone alone** — a laptop CLI step in the loop defeats that. The fix: bring the same "Examples" catalogue that already powers the web REPL's Examples panel (`apps/os/src/itx/examples.ts`) to the mobile app, so seeding test scenarios (or just poking at the platform) doesn't need a laptop at all.

## Decisions made while implementing

- **Execution mechanism: `capabilityHost.runScript`, not local JS eval.** The web REPL evals example code directly in the browser (`browser-repl.ts`'s `new Function(...)`, with `esm.sh` import rewriting). That's real complexity (top-level-statement rewriting, import handling) built for a genuine in-browser coding surface — wrong shape for a phone. Every example is already provable via the `"run-script"` runtime (`itx.capabilityHost.runScript(code)` — the exact server-side script isolate agents use), so the mobile runner uses that: no code eval on-device, no new security surface, and it's the runtime the e2e matrix already proves examples against.
- **Promoted `runExample`/`runScriptEnvelope` out of `e2e/test-support/`** into `apps/os/src/itx/run-example.ts` (product source) — it now has a real non-test consumer (the mobile app), and reaching into `e2e/` from product code was the wrong dependency direction. `apps/os/e2e/examples/example-matrix.ts`'s `run-script` runtime now imports from the new location; the old `e2e/test-support/run-example.ts` is deleted.
- **Filter to `context: "project"` examples whose `runtimes` includes `"run-script"`.** Session-context (`whoami`, `list-projects`) and agent-context examples don't fit a project-scoped "run" button; examples that only work in a live browser/Node session (`provide-live-capability` and friends — see `LIVE_SESSION_RUNTIMES` in `examples-source.ts`) aren't `run-script`-capable anyway, so the filter falls out naturally.
- **v1 runs with empty vars (`{}`)** — every example already has sensible `vars.x ?? default` fallbacks, so no per-example form-generation UI. Shows the raw JSON result or the error. A vars-editing UI is a reasonable follow-up, not required for the "seed a scenario from my phone" goal.
- **Added `egress-rules-configured`** to the catalogue (`examples-source.ts`): appends a `hold` rule for a host, deterministic and e2e-proven (unlike `egress-fetch`, which needs a real external service and stays interactive-only). This is the specific example that unblocks the human-in-the-loop-approvals on-device test: seed a hold rule from the phone, ask an agent to fetch that host, approve on the same phone — no laptop anywhere in the loop.

## Checklist

- [x] Promote `run-example.ts` from `apps/os/e2e/test-support/` to `apps/os/src/itx/` — _typechecks, `example-matrix.ts`'s `run-script` runtime updated to the new import; old file deleted_
- [x] Add the `egress-rules-configured` example to `examples-source.ts` + regenerate `examples.generated.ts` — _new matrix case in `example-cases.ts` (`.invalid` TLD host so nothing real ever gets contacted), live-verified passing across every server-side runtime (node/cli/run-script/project-worker) against a local dev server_
- [ ] `apps/mobile/src/lib/examples.ts` — filter `ITX_EXAMPLES` to phone-runnable entries
- [ ] `apps/mobile/src/lib/run-example.ts` — thin wrapper calling `itx.projects.get(id).capabilityHost` into the shared `runExample()`
- [ ] `apps/mobile/src/app/project/[projectId]/examples.tsx` — list + run + result screen
- [ ] Nav entry point (project chat-list header, alongside Approvals)
- [ ] Unit test for the phone-runnable filter
- [ ] Live e2e: run `egress-rules-configured` (or another deterministic example) through the mobile app's own code from Node, same pattern as `apps/mobile/e2e/*.e2e.test.ts`
- [ ] Manual on-device pass: open Examples, run `egress-rules-configured` against a real project, confirm the Approvals screen then sees a held request after asking an agent to fetch that host — the actual end-to-end "no laptop needed" proof

## Out of scope (v1)

- Per-example vars-editing UI (empty-vars defaults only)
- Non-`run-script`-capable examples (session/agent-context, live-session-only)
- Any change to the web REPL or the example catalogue's browser-eval path

## Implementation log

- 2026-07-16: `apps/os` half done and live-verified. Blocked here on PR #2044 (`os-ios-app`, adds `apps/mobile` to main) merging — this branch was created before that merge to get a head start on the OS-side pieces, which don't depend on `apps/mobile` existing. Next: merge #2044, pull main into this branch, build the mobile screen.
