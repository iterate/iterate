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
    const measurePhase = <Value>(name: string, category: string, operation: () => Promise<Value>) =>
      measureE2ePhase(annotate, name, category, operation);

    await using handle = await measurePhase("create test project", "fixture", () =>
      createTestProject({ slugPrefix: "script-reuse" }),
    );
    using itx = handle.itx();

    // Run 1: the "expensively derived" script, its input inline as a literal.
    // `target` deliberately shadows an identifier the script uses — aliasing
    // makes that a non-issue (live models pick the colliding name first).
    const first = await measurePhase("run original script", "operation", () =>
      itxScript(itx.capabilityHost).execute(async (_itx) => {
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
      }),
    );
    expect(first.success()).toEqual(["89", "97"]);

    // Run 2: no re-derivation — point at run 1's request event, the offset
    // the preamble `results` array exposes as `scriptOffset`.
    const settledOffset = first.execution.completedEvent.offset;
    const requestedOffset = await measurePhase("find request offset", "fixture", async () => {
      const requests = await itx.streams.get("/").getEvents({
        eventTypes: ["events.iterate.com/capability-host/script-run-requested"],
        limit: 100,
      });
      return requests.find((e: any) => e.payload.executionId === first.execution.executionId)!
        .offset;
    });
    const second = await measurePhase("reuse script with new input", "operation", () =>
      itxScript(itx.capabilityHost)
        .vars({ eventOffset: requestedOffset })
        .execute(async (itxInScript, vars) => {
          const helper = await itxInScript.capabilityHost.previousScriptHelper({
            scriptOffset: vars.eventOffset,
            parameterize: { target: 8633n },
          });
          return await helper.run({ target: 10403n });
        }),
    );
    expect(second.success()).toEqual(["101", "103"]);

    // Strict by design: any other event kind — here run 1's settle offset —
    // is rejected with the fix (pass a results row) named in the error.
    const settleRejection = await measurePhase("reuse via settle offset", "operation", () =>
      itxScript(itx.capabilityHost)
        .vars({ eventOffset: settledOffset })
        .execute(async (itxInScript, vars) => {
          return await itxInScript.capabilityHost.previousScriptHelper({
            scriptOffset: vars.eventOffset,
            parameterize: {},
          });
        })
        .then(() => "unexpectedly succeeded")
        .catch((error: Error) => String(error)),
    );
    expect(settleRejection).toContain("not a script-run-requested event");
    expect(settleRejection).toContain("carries scriptOffset");

    // The typed surface: run(vars) is inferred from the parameters object, so
    // passing the bigint as a string — the live models' favorite mistake —
    // dies at the server's typecheck gate before anything runs. Sent as raw
    // source because the test file itself would (correctly) refuse to compile
    // this.
    const wrongType = await measurePhase("reuse with wrongly typed vars", "operation", () =>
      itxScript(itx.capabilityHost)
        .vars({ eventOffset: requestedOffset })
        .executeSource(
          `async (itx, vars) => {
            const helper = await itx.capabilityHost.previousScriptHelper({
              scriptOffset: vars.eventOffset,
              parameterize: { target: 8633n },
            });
            return await helper.run({ target: "10403n" });
          }`,
        )
        .then(() => "unexpectedly succeeded")
        .catch((error: Error) => String(error)),
    );
    expect(wrongType).not.toBe("unexpectedly succeeded");
    expect(wrongType).toMatch(/string.*not assignable|must be a bigint/s);

    // A failed run must be rejected as a reuse source: live agents were
    // observed pointing the next attempt at their own failed attempt
    // (results[0] shifts to the error row) and nesting until they gave up.
    const failure = await measurePhase("run a failing script", "operation", () =>
      itxScript(itx.capabilityHost)
        .execute(async (_itx) => {
          throw new Error("deliberate failure");
        })
        .then(() => "unexpectedly succeeded")
        .catch((error: Error) => String(error)),
    );
    expect(failure).toContain("deliberate failure");
    const failedRequest = await measurePhase("find the failed request", "assertion", async () => {
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
    });
    expect(failedRequest).toBeDefined();
    const reuseOfFailed = await measurePhase("reuse the failed run", "operation", () =>
      itxScript(itx.capabilityHost)
        .vars({ eventOffset: failedRequest!.offset })
        .execute(async (itxInScript, vars) => {
          return await itxInScript.capabilityHost.previousScriptHelper({
            scriptOffset: vars.eventOffset,
            parameterize: {},
          });
        })
        .then(() => "unexpectedly succeeded")
        .catch((error: Error) => String(error)),
    );
    expect(reuseOfFailed).toContain("FAILED");
    expect(reuseOfFailed).toContain("Reuse a run that succeeded");
  },
);
