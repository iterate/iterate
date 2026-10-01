---
status: done
size: small
---

# The mid-script reply row holds its script with a gate, not a KV key

Status: done. The row lends the script `itx.go` (a `Gate` RpcTarget) and opens it in `finally`; passes locally 4/4. Deployed proof is this PR's Preview OS E2E run.

## Why

`test/vitest/agents/agents.e2e.test.ts` › "words sent while a script runs are answered at once…"
flakes on deployed runs (3 failures on 2026-10-01, both attempts each time): `until(the script's
settlement): timed out after 20000ms`, log ends at `agent/web-message-sent`, no `itx/run-settled`.

Cause (found in an earlier session): the fake model's script spins on `itx.kv.get("go")` and the
test releases it with `itx.kv.put("go", "yes")`. `itx.kv` is Workers KV, eventually consistent: the
script's first reads cache a "not found" at its location, which can outlive the 20 s wait by up to
~60 s. test/vitest/AGENTS.md already says not to wait on an eventually consistent read in an e2e row.

The row tests the agent's mid-script reply and feed, not KV. Polling KV every 200 ms is also extra
subrequest noise in one of the slowest rows (78–84 s with its retry).

## Plan

The test lends the script a gate and opens it itself. The script awaits one call that answers when
the test resolves a promise: no polling, no consistency question.

```ts
const go = Promise.withResolvers<void>();
await support.provide("itx.go", new Gate(go.promise)); // hypothetical shape
// script: await itx.go.wait();
// finally: go.resolve();
```

`provide` lends a live RpcTarget like `FakeAi` (agents-partner-response-stream.e2e.test.ts already
holds a model stream on a test-owned promise).

- [x] swap the KV handshake for a provided gate in the row _`Gate` at the bottom of agents.e2e.test.ts; script is `await itx.go.wait()`_
- [x] run the row locally, several times _4/4 pass, 15–16.5 s; the old KV version also takes 15–16.5 s locally, where KV reads its own writes_
- [x] typecheck, lint, format _plus knip; all clean_
