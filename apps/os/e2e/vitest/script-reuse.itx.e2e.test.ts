/**
 * Goal coverage: `itx.capabilityHost.previousScriptHelper` end to end — a
 * script journaled by one run is re-parameterized and re-executed by a later
 * script with new inputs, through the returned handle's `run(vars)`, the
 * offset lookup, and a journaled child run. No model turns.
 */
import { test } from "vitest";
import { measureE2ePhase } from "@iterate-com/shared/test-support/measure-e2e-phase";
import { createTestProject } from "../test-support/create-test-project.ts";
import { itxScript } from "../test-support/itx-script-builder.ts";

test(
  "a later script reuses an earlier journaled script with new inputs",
  { timeout: 120_000 },
  async ({ annotate, expect }) => {
    await using handle = await measureE2ePhase(annotate, "create test project", "fixture", () =>
      createTestProject({ slugPrefix: "script-reuse" }),
    );
    using itx = handle.itx();
    const script = itxScript(itx.capabilityHost, { annotate });

    // Run 1: the "expensively derived" script, its input inline as a literal.
    // `target` deliberately shadows an identifier the script uses — aliasing
    // makes that a non-issue (live models pick the colliding name first).
    const first = await script.execute(async function runOriginalScript(_itx) {
      const target = 8633n;
      let remaining = target;
      const factors: bigint[] = [];
      for (let candidate = 2n; candidate * candidate <= remaining; candidate += 1n) {
        while (remaining % candidate === 0n) {
          factors.push(candidate);
          remaining /= candidate;
        }
      }
      if (remaining > 1n) factors.push(remaining);
      return factors.map(String);
    });
    expect(first.success()).toEqual(["89", "97"]);

    // Run 2: no re-derivation — point at run 1's request event, which
    // runScript hands back as `scriptEvent` (the same offset the preamble
    // `results` array exposes as `scriptOffset`).
    const requestedOffset = first.execution.scriptEvent.offset;
    const settledOffset = first.execution.completedEvent.offset;
    const second = await script
      .vars({ eventOffset: requestedOffset })
      .execute(async function reuseScriptWithNewInput(itxInScript, vars) {
        const helper = await itxInScript.capabilityHost.previousScriptHelper({
          scriptOffset: vars.eventOffset,
          parameterize: { target: 8633n },
        });
        return await helper.run({ target: 10403n });
      });
    expect(second.success()).toEqual(["101", "103"]);

    // Edits rewrite text that is not a parameter value — here the returned
    // shape, proving the edit ran against the journaled source.
    const edited = await script
      .vars({ eventOffset: requestedOffset })
      .execute(async function reuseWithEdits(itxInScript, vars) {
        const helper = await itxInScript.capabilityHost.previousScriptHelper({
          scriptOffset: vars.eventOffset,
          parameterize: { target: 8633n },
          edits: [["factors.map(String)", "factors.map((f) => `p${f}`)"]],
        });
        return await helper.run({ target: 10403n });
      });
    expect(edited.success()).toEqual(["p101", "p103"]);

    // Strict by design: any other event kind — here run 1's settle offset —
    // is rejected with the fix (pass a results row) named in the error.
    const settleRejection = script
      .vars({ eventOffset: settledOffset })
      .execute(async function reuseViaSettledOffset(itxInScript, vars) {
        return await itxInScript.capabilityHost.previousScriptHelper({
          scriptOffset: vars.eventOffset,
          parameterize: {},
        });
      });
    await expect(settleRejection).rejects.toThrowError(/not a script-run-requested event/);

    // The typed surface: run(vars) is inferred from the parameterize object,
    // so passing the bigint as a string — the live models' favorite mistake —
    // dies at the server's typecheck gate before anything runs. Sent as raw
    // source because the test file itself would (correctly) refuse to compile
    // this.
    const wrongType = script.vars({ eventOffset: requestedOffset }).executeSource(
      `async (itx, vars) => {
          const helper = await itx.capabilityHost.previousScriptHelper({
            scriptOffset: vars.eventOffset,
            parameterize: { target: 8633n },
          });
          return await helper.run({ target: "10403n" });
        }`,
    );
    await expect(wrongType).rejects.toThrowError(/string.*not assignable|must be a bigint/s);

    // A failed run must be rejected as a reuse source: live agents were
    // observed pointing the next attempt at their own failed attempt
    // (results[0] shifts to the error row) and nesting until they gave up.
    const failing = script.execute(async function runFailingScript(_itx) {
      throw new Error("deliberate failure");
    });
    await expect(failing).rejects.toThrowError(/deliberate failure/);
    const failedRequest = await measureE2ePhase(
      annotate,
      "find the failed request",
      "assertion",
      async () => {
        const settled = await itx.streams.get("/").getEvents({
          eventTypes: ["events.iterate.com/capability-host/script-run-settled"],
          limit: 100,
        });
        const failedSettle = settled.findLast(
          (e: any) => e.payload?.settlement?.status === "failed",
        )!;
        const requests = await itx.streams.get("/").getEvents({
          eventTypes: ["events.iterate.com/capability-host/script-run-requested"],
          limit: 100,
        });
        return requests.find(
          (e: any) => e.payload.executionId === failedSettle.payload?.executionId,
        )!;
      },
    );
    expect(failedRequest).toBeDefined();
    const reuseOfFailed = script
      .vars({ eventOffset: failedRequest!.offset })
      .execute(async function reuseTheFailedRun(itxInScript, vars) {
        return await itxInScript.capabilityHost.previousScriptHelper({
          scriptOffset: vars.eventOffset,
          parameterize: {},
        });
      });
    await expect(reuseOfFailed).rejects.toThrowError(/FAILED.*Reuse a run that succeeded/s);
  },
);
