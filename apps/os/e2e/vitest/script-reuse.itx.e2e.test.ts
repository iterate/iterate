/**
 * Goal coverage: `itx.previousScriptAsHelperFunction` end to end — a script
 * journaled by one run is re-parameterized and re-executed by a later script
 * with new inputs, through the harness-manufactured callable, the
 * prepareScriptReuse lookup, and a journaled child run. No model turns.
 */
import { test } from "vitest";
import { measureE2ePhase } from "@iterate-com/shared/test-support/measure-e2e-phase";
import { createTestProject } from "../test-support/create-test-project.ts";
import { itxScript } from "../test-support/itx-script-builder.ts";

// The harness-only surface: manufactured inside script isolates, so it is not
// on the generated Project type (RPC cannot return a plain function).
type ScriptReuseSurface = {
  previousScriptAsHelperFunction(options: {
    eventOffset: number;
    parameters: { name: string; content: string }[];
  }): Promise<(itx: unknown, vars?: Record<string, unknown>) => Promise<unknown>>;
};

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

    // Run 2: no re-derivation — point at run 1 (by its settle offset, the one
    // the preamble `results` array exposes) and call it with a new number.
    const settledOffset = first.execution.completedEvent.offset;
    const second = await measurePhase("reuse script with new input", "operation", () =>
      itxScript(itx.capabilityHost)
        .context<ScriptReuseSurface>()
        .vars({ eventOffset: settledOffset })
        .execute(async (itxInScript, vars) => {
          const factorize = await itxInScript.previousScriptAsHelperFunction({
            eventOffset: vars.eventOffset,
            parameters: [{ name: "input", content: "8633n" }],
          });
          return await factorize(itxInScript, { input: 10403n });
        }),
    );
    expect(second.success()).toEqual(["101", "103"]);

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
    const failedSettle = await measurePhase("find the failed settlement", "assertion", async () => {
      const settled = await itx.streams.get("/").getEvents({
        eventTypes: ["events.iterate.com/capability-host/script-run-settled"],
        limit: 100,
      });
      return settled.findLast((e: any) => e.payload?.settlement?.status === "failed");
    });
    expect(failedSettle).toBeDefined();
    const reuseOfFailed = await measurePhase("reuse the failed run", "operation", () =>
      itxScript(itx.capabilityHost)
        .context<ScriptReuseSurface>()
        .vars({ eventOffset: failedSettle!.offset })
        .execute(async (itxInScript, vars) => {
          return await itxInScript.previousScriptAsHelperFunction({
            eventOffset: vars.eventOffset,
            parameters: [],
          });
        })
        .then(() => "unexpectedly succeeded")
        .catch((error: Error) => String(error)),
    );
    expect(reuseOfFailed).toContain("FAILED");
    expect(reuseOfFailed).toContain("Reuse a run that succeeded");
  },
);
