// The 2026-09-02 incident, verified against a REAL deployed OS worker — the
// check that isn't circular: real workerd, the real 128MiB Durable Object
// isolate, the real chunk-blob StreamEventLog and settlement path. The node
// repro (src/domains/streams/oversized-settlement-crash.test.ts) proves the
// crash shape under a node heap proxy; this proves the fix on the real engine.
//
// WHAT WAS MEASURED on preview_5 (2026-09-02), by hand, both worker versions:
//   - no fix: a codemode script returning ~7MB journals a ~7,090KB settlement
//     verbatim (confirmed on the stream). Its fold/read materialization DID
//     reset the real isolate — observed as both "Durable Object's isolate
//     exceeded its memory limit and was reset" (getEventPage over a dozen such
//     settlements) and "Internal error in Durable Object storage caused object
//     to be reset" (during a 20-settlement journaling fan-out).
//   - fix: the same script's result is bounded at the settlement boundary —
//     journaled at ~3KB with `oversized.kind === "omitted"` — and runScript
//     rejects with a clear "too large to retain" instead of returning 7MB.
//
// WHY THIS TEST ASSERTS THE BOUND, NOT THE RESET. The reset itself is a memory
// threshold: on a clean single-client preview the client read paths are
// byte-guarded and each settlement's fold is individually transient, so it
// takes the concurrent multi-facet + multi-subscriber fan-out under an already
// large conversation (the prod conditions) to tip 128MiB — not reliably
// reproducible from one e2e, and a flaky pin is a bad pin. What IS deterministic
// on the real engine is the fix's mechanism: an oversized settlement is bounded
// before it is journaled. That is the exact thing whose absence caused the
// reset, so guarding it on real workerd is the honest, stable check.
//
// Pinned with failing(/journaled unbounded/): against a preview WITHOUT the fix
// the oversized result comes back unbounded (pin green); WITH the fix it is
// bounded, the body passes, and the pin flips red — delete the wrapper.
//
// Run against a preview (never shared/prod — it deliberately stresses a DO):
//   doppler run --config preview_N -- pnpm --dir apps/os e2e --run oversized-settlement-isolate
import { expect, test } from "vitest";
import { failing } from "@iterate-com/shared/test-support/failing-test";
import { adminSecret, deployedBaseUrl, withItxSession } from "./test-helpers.ts";

// ~7MB, the incident's shape: a base64 blob in a script's stdout.
const OVERSIZED_SCRIPT = `async () => ({ stdout: "iVBORw0KGgo".repeat(660_000) })`;
// The bound the fix enforces (settlement events fan out to every fold and
// subscriber, so a durable one this large is a memory bomb).
const MAX_SETTLEMENT_BYTES = 1_000_000;

const failUnbounded = failing(test, /journaled unbounded/i, { timeoutMs: 90_000 });

failUnbounded("an oversized script result is bounded before it is journaled", async () => {
  // Guard: only ever run this against a preview — it deliberately stresses a DO.
  if (deployedBaseUrl() === null) {
    throw new Error("oversized-settlement e2e must run against a deployed preview (not local)");
  }

  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects
    .get(`oversized-settlement-${crypto.randomUUID().slice(0, 8)}`)
    .create({});

  // Run the oversized script through the real product path. With the fix this
  // rejects with a bounded "too large to retain" explanation; without it, it
  // resolves with the whole ~7MB value.
  const returnedBytes = await project.capabilityHost
    .runScript(OVERSIZED_SCRIPT)
    .then((settled) => JSON.stringify(settled.result ?? null).length)
    .catch((error: unknown) => {
      if (/too large to retain/i.test(String(error))) return 0; // bounded — the fix
      throw error;
    });

  const message = `oversized script result journaled unbounded (${returnedBytes} chars) — this resets the stream DO isolate under the fold/delivery fan-out`;
  expect(returnedBytes, message).toBeLessThan(MAX_SETTLEMENT_BYTES);
});
