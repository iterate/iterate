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
`WebSocket connection failed.`, so the basic client handshake bound works.
The recurrence below identifies a server-side terminal failure instead of a
client-handshake defect.

## 2026-07-23 recurrence: server-side terminal failure identified

PR #2265's second formal preview run reproduced the outer 90-second fixture
timeout in `empty agent feeds distinguish waiting from filtered zero matches`.
This time the named timing and trace evidence identify the exact project and
terminal state:

- Failed project: `prj_ddc2a50bba2941878bed307b207417ea` (slug
  `agent-initializing-mrwsg32j-f065698a`).
- Root trace: `eb26b8dc5ae96c5da9373abef6e8606d` on `os-preview-11`.
- `Project.create` remained pending for 88.3 seconds until Playwright canceled
  the request. Project birth took 37.7 seconds; config-repo birth took 36.3
  seconds.
- Inside config-repo birth, `artifact-get-or-create` failed after 32.7 seconds.
  The config stream then recorded `repos/create-failed` with `An internal error
  occurred.` and cross-posted it to the root stream. It never recorded
  `repos/created` or `project/ready`, including after later processor wakes.
- The test retry created `prj_20587…`, completed birth in 3.8 seconds, and
  passed. The test retry therefore hid a defective first project; this was not
  merely a slow browser or a lost readiness notification.

Cloudflare's binding contract classifies this as Artifacts `INTERNAL_ERROR`.
Repo creation previously treated every Artifacts error except a
still-materializing repo as a permanent domain failure. PR #2265 changes the
processor to redeliver the already-idempotent creation obligation for
`INTERNAL_ERROR` and `UPSTREAM_UNAVAILABLE`, while preserving terminal
fail-closed behavior for invalid input and other domain errors. The focused
recovery test proves that the first service error appends no `create-failed`,
the next delivery succeeds, and exactly one `repos/created` fact is recorded.

## Remaining proof

- Prove the fix with repeated retry-disabled preview runs and zero unexplained
  error/retry telemetry.
