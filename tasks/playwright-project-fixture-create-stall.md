---
state: todo
priority: medium
size: medium
tags: [ci, playwright, itx, preview, flake]
---

# Diagnose and bound stalled Playwright project fixture creation

Found on 2026-07-17 while landing [PR #2075](https://github.com/iterate/iterate/pull/2075).
The PR's TUI spec passed on its first attempt, but an unrelated browser spec was
reported as flaky inside an otherwise-green preview check:

- Evidence check: [Cloudflare Previews / deploy + e2e](https://github.com/iterate/iterate/runs/87914836519)
  ([Depot job](https://depot.dev/orgs/0p91s0lz49/workflows/65wvlq6frq?job=b4tc9c4nkg)).
- Depot attempt: `cgw3bdlr53`; test-results artifact:
  `019f7090-8f07-707c-a531-488f39e9051b`.
- Test: `specs/repl-examples.spec.ts` →
  `runs "discover-tree" through the project REPL`.
- First attempt: worker 7, started `2026-07-17T14:49:58.765Z`, timed out
  after `90,037ms`, with a completely blank screenshot and no stdout/stderr.
- Playwright retry: worker 8, started `2026-07-17T14:51:29.392Z`, passed in
  `10,800ms` with the same example.

Artifact files:

- `playwright-results.json` contains both attempts and the exact timings.
- `playwright-output/repl-examples-itx-REPL-cat-52d08-ee-through-the-project-REPL-chromium/test-failed-1.png`
  is the blank first-attempt screenshot.
- The corresponding `error-context.md` contains only the outer 90-second test
  timeout.
- `...-retry1/trace.zip` covers the successful retry only because
  `playwright.config.ts` currently uses `trace: "on-first-retry"`.

## Server-side evidence

Cloudflare Workers observability was queried for account
`376ef7ed81b0573f93524de763666c15`, service `os-preview-4`, and the bounded
window `2026-07-17T14:49:50Z`–`14:51:35Z`.

A case-insensitive all-dataset search for `repl-discover-tree` returned only
two events, both at `2026-07-17T14:51:30.687Z` after the retry began:

- `[create-timing] {"slug":"repl-discover-tree-mrp2322f-f1f0ef19","step":"auth-register","ms":317,"ok":true}`
- the matching `PROJECT_DIRECTORY` KV write on trace
  `d816008d61a5e794f53445a480d1bc39`.

There is no `repl-discover-tree` slug event during the failed attempt. Project
creation for the successful retry reached OS immediately, while the first
attempt never completed the earliest logged `auth-register` create step.
This fits the blank page: `helpers.createFixture()` runs before `page.goto()`.
It does **not** implicate the REPL example or this PR's terminal work.

The relevant client path is:

1. `specs/test-support/test.ts` → `helpers.createFixture`
2. `specs/test-support/forged-session.ts` → `createProjectFixture`
3. `createAdminProject` → `await created.__describe()`

`packages/iterate/src/itx/itx-node-client.ts` already configures a 15-second
WebSocket handshake timeout. A local socket that accepted TCP but never
answered the upgrade rejected an in-flight RPC after `15,011ms` with
`WebSocket connection failed.`, so the basic client handshake bound works;
the preview failure needs stage-level evidence before changing that client.

## Work

- Attach named, timed fixture stages (config, admin itx connect/create,
  description/readiness, token mint, cookie install) to Playwright results so
  an outer timeout identifies the pending operation and fixture slug.
- Capture a failed first-attempt trace (or equivalent client frame/transport
  evidence) without relying on the retry trace.
- Reproduce against a preview with normal CI concurrency; correlate the slug,
  WebSocket session, `ProjectCollection.create` RPC, and `create-timing` steps.
- Fix the demonstrated pending operation. Keep recovery bounded and observable;
  do not turn the fixture into an unreported inner retry loop.
- Prove the fix with repeated retry-disabled preview runs and zero unexplained
  error/retry telemetry.
