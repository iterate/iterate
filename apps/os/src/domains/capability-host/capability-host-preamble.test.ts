// The preamble's executable spec at two levels: the pure assembly (settlement
// → retained row → rendered `results` array, in both the ts and js variants)
// and the host verbs (setPreamble's set-time compile gate, removePreamble,
// describePreamble, getScriptResult's loader read-back) on the same
// runner-driven MemoryStream harness capability-types-metadata.test.ts uses.
// The REAL compiler's verdict on assembled preambles lives in
// domains/typecheck/virtual-project.test.ts.

import { describe, expect, it, vi } from "vitest";
import { StreamProcessorRunner } from "iterate/processors";
import { MemoryStream } from "iterate/processors/testing";
import type { Project } from "../../itx-api.generated.ts";
import type { CapabilityHostProcessorContract } from "./capability-host-processor-contract.ts";
import {
  CapabilityHostProcessor,
  type CapabilityHostProcessorDeps,
} from "./capability-host-processor-implementation.ts";
import {
  assemblePreamble,
  INLINE_RESULT_PREAMBLE_LIMIT,
  retainedScriptResult,
} from "./capability-host-preamble.ts";

describe("retainedScriptResult", () => {
  it("keeps a small result verbatim as compact JSON", () => {
    expect(
      retainedScriptResult({
        executionId: "agent-output:57",
        scriptOffset: 55,
        settledAtOffset: 57,
        settlement: { status: "succeeded", result: { users: ["amy", "bob"] } },
      }),
    ).toEqual({
      kind: "data",
      executionId: "agent-output:57",
      scriptOffset: 55,
      settledAtOffset: 57,
      resultJson: '{"users":["amy","bob"]}',
    });
  });

  it("keeps only the inferred type for a result over the inline limit", () => {
    const big = { items: Array.from({ length: 5_000 }, (_, i) => ({ id: `item-${i}` })) };
    expect(JSON.stringify(big).length).toBeGreaterThan(INLINE_RESULT_PREAMBLE_LIMIT);
    const row = retainedScriptResult({
      executionId: "agent-output:42",
      scriptOffset: 40,
      settledAtOffset: 42,
      settlement: { status: "succeeded", result: big },
    });
    expect(row).toMatchObject({ kind: "large", executionId: "agent-output:42" });
    expect((row as { typeText: string }).typeText).toContain("id: string");
  });

  it("keeps a failed script's error, truncated", () => {
    const row = retainedScriptResult({
      executionId: "agent-output:33",
      scriptOffset: 31,
      settledAtOffset: 33,
      settlement: {
        status: "failed",
        error: `TypeError: boom ${"x".repeat(3_000)}`,
        failureKind: "runtime",
        phase: "execution",
        executionMayHaveOccurred: true,
        cancellation: "external-work-may-continue",
      },
    });
    expect(row).toMatchObject({ kind: "error", executionId: "agent-output:33" });
    const error = (row as { error: string }).error;
    expect(error).toContain("TypeError: boom");
    expect(error.length).toBeLessThan(2_100);
  });

  it("retains a payload-free done row for a script that returned undefined (its offset is the reuse handle)", () => {
    expect(
      retainedScriptResult({
        executionId: "agent-output:9",
        scriptOffset: 7,
        settledAtOffset: 9,
        settlement: { status: "succeeded" },
      }),
    ).toEqual({ kind: "done", executionId: "agent-output:9", scriptOffset: 7, settledAtOffset: 9 });
  });

  it("omits scriptOffset when no request was reduced (external settlement)", () => {
    expect(
      retainedScriptResult({
        executionId: "agent-output:9",
        scriptOffset: undefined,
        settledAtOffset: 9,
        settlement: { status: "succeeded" },
      }),
    ).toEqual({ kind: "done", executionId: "agent-output:9", settledAtOffset: 9 });
  });
});

describe("assemblePreamble", () => {
  const ROWS = [
    // state order: oldest first
    {
      kind: "error" as const,
      executionId: "agent-output:33",
      settledAtOffset: 33,
      error: "TypeError: boom",
    },
    {
      kind: "large" as const,
      executionId: "agent-output:42",
      settledAtOffset: 42,
      typeText: "{ items: { id: string }[] }",
    },
    {
      kind: "data" as const,
      executionId: "agent-output:57",
      settledAtOffset: 57,
      resultJson: '{"users":["amy","bob"]}',
    },
  ];

  it("returns null for an empty scope — the common case pays nothing", () => {
    expect(assemblePreamble({ entries: [], results: [] })).toBeNull();
  });

  it("renders results newest first with data/load/error per row, plus user entries in first-set order", () => {
    const assembled = assemblePreamble({
      entries: [{ key: "channels", code: 'const TECH_CHANNEL_ID = "c1234";' }],
      results: ROWS,
    });
    expect(assembled).not.toBeNull();
    const { ts } = assembled!;
    // newest first: the inline data row leads, the loader row follows, the error row last
    const dataIndex = ts.indexOf('"agent-output:57"');
    const loadIndex = ts.indexOf('"agent-output:42"');
    const errorIndex = ts.indexOf('"agent-output:33"');
    expect(dataIndex).toBeGreaterThan(-1);
    expect(loadIndex).toBeGreaterThan(dataIndex);
    expect(errorIndex).toBeGreaterThan(loadIndex);
    expect(ts).toContain('data: {"users":["amy","bob"]}');
    expect(ts).toContain("get data(): never");
    expect(ts).toContain("await results[1].load(itx)");
    expect(ts).toContain('getScriptResult("agent-output:42")');
    expect(ts).toContain('error: "TypeError: boom"');
    expect(ts).toContain("] as const;");
    // stable addressing: every row wears its settle offset, and the array
    // carries byOffset alongside the positional tuple
    expect(ts).toContain("offset: 57,");
    expect(ts).toContain("byOffset:");
    // user entries render after the results array
    expect(ts.indexOf("TECH_CHANNEL_ID")).toBeGreaterThan(errorIndex);
  });

  it("results.byOffset addresses one row stably by its settle offset", async () => {
    const { js } = assemblePreamble({ entries: [], results: ROWS })!;
    const results = (await evaluatePreambleJs(js)) as {
      byOffset: (offset: number) => { executionId: string; offset: number };
    } & { executionId: string; offset: number }[];
    // positional and stable addressing agree on the same rows
    expect(results[0]).toMatchObject({ executionId: "agent-output:57", offset: 57 });
    expect(results.byOffset(42)).toMatchObject({ executionId: "agent-output:42", offset: 42 });
    expect(results.byOffset(33)).toMatchObject({ executionId: "agent-output:33", offset: 33 });
    // outside the retained window: loud, not undefined
    expect(() => results.byOffset(999)).toThrow("no retained script result settled at offset 999");
  });

  it("a done row renders offset + scriptOffset + executionId — the reuse handle for void scripts", async () => {
    const { ts, js } = assemblePreamble({
      entries: [],
      results: [
        { kind: "done", executionId: "agent-output:9", scriptOffset: 7, settledAtOffset: 9 },
      ],
    })!;
    expect(ts).toContain("done: true");
    expect(ts).toContain("scriptOffset: 7,");
    const results = (await evaluatePreambleJs(js)) as { offset: number }[];
    expect(results[0]).toMatchObject({
      offset: 9,
      scriptOffset: 7,
      executionId: "agent-output:9",
      done: true,
    });
  });

  it("the js variant is runnable JavaScript with the same bindings (no TS syntax)", async () => {
    const { js } = assemblePreamble({
      entries: [{ key: "helper", code: "function twice(n) { return n * 2; }" }],
      results: ROWS,
    })!;
    expect(js).not.toContain("as const");
    expect(js).not.toContain(": never");
    expect(js).not.toContain("type Result");
    // Evaluates as real JavaScript — the exact property the no-emit fallback
    // needs.
    const results = (await evaluatePreambleJs(js)) as { executionId: string }[];
    expect(results[0]).toMatchObject({ executionId: "agent-output:57" });
  });

  it("a result carrying a literal __proto__ key falls back to JSON.parse instead of an object literal", async () => {
    const { ts, js } = assemblePreamble({
      entries: [],
      results: [
        {
          kind: "data",
          executionId: "agent-output:1",
          settledAtOffset: 1,
          resultJson: '{"__proto__":{"polluted":true}}',
        },
      ],
    })!;
    expect(ts).toContain("JSON.parse(");
    const results = (await evaluatePreambleJs(js)) as { data: Record<string, unknown> }[];
    const data = results[0]!.data;
    // JSON.parse keeps __proto__ as a plain own property; a literal would
    // have silently set the prototype instead.
    expect(Object.hasOwn(data, "__proto__")).toBe(true);
    expect((data as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// Host verbs, on the runner-driven MemoryStream harness (see
// capability-types-metadata.test.ts for the drive pattern).
// -----------------------------------------------------------------------------

const PREAMBLE_SET = "events.iterate.com/capability-host/preamble-set";

describe("CapabilityHostProcessor preamble verbs", () => {
  it("setPreamble appends the keyed fact; the reduce upserts in first-set order", async () => {
    const harness = await makeProcessor({ stream: bornStream() });
    await verbDelivered(harness, () =>
      harness.processor.setPreamble({ key: "channels", code: "const TECH = 'c1';" }),
    );
    await verbDelivered(harness, () =>
      harness.processor.setPreamble({ key: "helper", code: "const H = 1;" }),
    );
    // a re-set updates code without moving the entry
    await verbDelivered(harness, () =>
      harness.processor.setPreamble({ key: "channels", code: "const TECH = 'c2';" }),
    );
    expect(harness.runner.currentState.preamble).toMatchObject([
      { key: "channels", code: "const TECH = 'c2';" },
      { key: "helper", code: "const H = 1;" },
    ]);

    await verbDelivered(harness, () => harness.processor.removePreamble({ key: "channels" }));
    expect(harness.runner.currentState.preamble).toMatchObject([{ key: "helper" }]);
  });

  it("setPreamble rejects an entry that introduces compile problems, and allows one that does not", async () => {
    // The fake gate mimics checkPreamble: problems whenever the assembled
    // text mentions the broken symbol. A pre-existing broken entry appended
    // RAW (bypassing the verb, like a stale journal) must not veto later sets.
    const checkPreamble: CapabilityHostProcessorDeps["checkPreamble"] = (input) =>
      Promise.resolve(
        input.preamble.includes("BROKEN") ? ["preamble:1 — Cannot find name 'BROKEN'."] : [],
      );
    const stream = bornStream();
    const harness = await makeProcessor({ checkPreamble, stream });

    await expect(
      harness.processor.setPreamble({ key: "bad", code: "const x = BROKEN;" }),
    ).rejects.toThrow(/preamble entry "bad" does not compile[\s\S]*BROKEN/);
    expect(stream.events.filter((event) => event.type === PREAMBLE_SET)).toHaveLength(0);

    await stream.append({ type: PREAMBLE_SET, payload: { key: "stale", code: "BROKEN" } });
    await harness.runner.catchUp();
    // the stale entry makes the scope's assembled preamble broken, but this
    // candidate introduces nothing new — it must still land
    await verbDelivered(harness, () =>
      harness.processor.setPreamble({ key: "fine", code: "const ok = 1;" }),
    );
    expect(harness.runner.currentState.preamble).toMatchObject([{ key: "stale" }, { key: "fine" }]);
  });

  it("a re-set that shifts a stale entry's error line is not read as a new problem", async () => {
    // The fake gate reports the stale symbol AT ITS ACTUAL LINE in the
    // assembled text — re-setting an entry ABOVE it changes that number, and
    // a position-sensitive with/without diff would call the same old problem
    // newly introduced and reject a perfectly fine re-set.
    const checkPreamble: CapabilityHostProcessorDeps["checkPreamble"] = (input) => {
      const line = input.preamble.split("\n").findIndex((l) => l.includes("BROKEN")) + 1;
      return Promise.resolve(
        line === 0 ? [] : [`preamble:${line} — Cannot find name 'BROKEN'. (TS2304)`],
      );
    };
    const stream = bornStream();
    const harness = await makeProcessor({ checkPreamble, stream });
    await verbDelivered(harness, () =>
      harness.processor.setPreamble({ key: "first", code: "const a = 1;" }),
    );
    await stream.append({ type: PREAMBLE_SET, payload: { key: "stale", code: "BROKEN" } });
    await harness.runner.catchUp();

    // Re-set "first" to a DIFFERENT line count: the stale error shifts lines
    // between the with/without checks, but it is the same problem.
    await verbDelivered(harness, () =>
      harness.processor.setPreamble({ key: "first", code: "const a = 1;\nconst b = 2;" }),
    );
    expect(harness.runner.currentState.preamble).toMatchObject([
      { key: "first", code: "const a = 1;\nconst b = 2;" },
      { key: "stale" },
    ]);
  });

  it("describePreamble reports the assembled text and entry table; getScriptResult reads a settlement back", async () => {
    const stream = bornStream();
    const harness = await makeProcessor({ stream });
    expect(await harness.processor.describePreamble()).toBeNull();

    await stream.append(
      {
        type: "events.iterate.com/capability-host/script-run-settled",
        idempotencyKey: "capability-host/script-run-settled@exec-1",
        payload: {
          executionId: "exec-1",
          settlement: { status: "succeeded", result: { answer: 42 } },
        },
      },
      { type: PREAMBLE_SET, payload: { key: "channels", code: "const TECH = 'c1';" } },
    );
    await harness.runner.catchUp();

    const described = await harness.processor.describePreamble();
    expect(described).toMatchObject({ entries: [{ key: "channels" }] });
    expect(described!.text).toContain('data: {"answer":42}');
    expect(described!.text).toContain("const TECH = 'c1';");

    await expect(harness.processor.getScriptResult("exec-1")).resolves.toEqual({
      executionId: "exec-1",
      data: { answer: 42 },
    });
    await expect(harness.processor.getScriptResult("exec-nope")).rejects.toThrow(
      'no settled script execution "exec-nope"',
    );
  });
});

// ------------------------------------------------------------------ fixtures

/** Evaluate a js-variant preamble as a real ES module (module scope, exactly
 * like the emitted path) and hand back its `results` binding. */
async function evaluatePreambleJs(js: string): Promise<unknown> {
  const source = `${js}\nexport default results;`;
  const module = (await import(
    /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  )) as { default: unknown };
  return module.default;
}

function bornStream(): MemoryStream {
  const stream = new MemoryStream();
  stream.events.push({
    type: "events.iterate.com/capability-host/created",
    idempotencyKey: `capability-host/created:test:${stream.path}`,
    payload: { config: {}, fallback: null },
    createdAt: new Date().toISOString(),
    offset: 1,
    path: stream.path,
  });
  return stream;
}

type Harness = {
  processor: CapabilityHostProcessor;
  runner: StreamProcessorRunner<CapabilityHostProcessorContract>;
};

/** Verbs await read-your-writes delivery of their own append; MemoryStream
 * has no delivery loop, so pull the journal through the driving runner until
 * the verb settles (same pattern as capability-types-metadata.test.ts). */
async function verbDelivered(harness: Harness, verb: () => Promise<unknown>) {
  const pending = verb();
  let settled = false;
  pending.finally(() => (settled = true)).catch(() => {});
  await vi.waitFor(async () => {
    await harness.runner.catchUp();
    expect(settled).toBe(true);
  });
  return await pending;
}

async function makeProcessor(options: {
  stream: MemoryStream;
  checkPreamble?: CapabilityHostProcessorDeps["checkPreamble"];
}): Promise<Harness> {
  let runner!: Harness["runner"];
  const processor = new CapabilityHostProcessor({
    stream: options.stream,
    itx: {} as Project,
    path: "/",
    projectId: null,
    scriptExecutionEntrypoint: {
      run: () => {
        throw new Error("must not run in this scenario");
      },
    },
    checkPreamble: options.checkPreamble,
    reads: {
      snapshot: () => runner.snapshot(),
      waitUntilEvent: (input) =>
        "offset" in input ? runner.waitUntilEvent(input) : runner.waitUntilEvent(input),
    },
  });
  runner = new StreamProcessorRunner({ processor, stream: options.stream });
  await runner.catchUp();
  return { processor, runner };
}
