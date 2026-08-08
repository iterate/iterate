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
        settledAtOffset: 57,
        settlement: { status: "succeeded", result: { users: ["amy", "bob"] } },
      }),
    ).toEqual({
      kind: "data",
      executionId: "agent-output:57",
      settledAtOffset: 57,
      resultJson: '{"users":["amy","bob"]}',
    });
  });

  it("keeps only the inferred type for a result over the inline limit", () => {
    const big = { items: Array.from({ length: 5_000 }, (_, i) => ({ id: `item-${i}` })) };
    expect(JSON.stringify(big).length).toBeGreaterThan(INLINE_RESULT_PREAMBLE_LIMIT);
    const row = retainedScriptResult({
      executionId: "agent-output:42",
      settledAtOffset: 42,
      settlement: { status: "succeeded", result: big },
    });
    expect(row).toMatchObject({ kind: "large", executionId: "agent-output:42" });
    expect((row as { typeText: string }).typeText).toContain("id: string");
  });

  it("keeps a failed script's error, truncated", () => {
    const row = retainedScriptResult({
      executionId: "agent-output:33",
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

  it("retains nothing for a script that returned undefined (that is how turns end)", () => {
    expect(
      retainedScriptResult({
        executionId: "agent-output:9",
        settledAtOffset: 9,
        settlement: { status: "succeeded" },
      }),
    ).toBeNull();
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
    // user entries render after the results array
    expect(ts.indexOf("TECH_CHANNEL_ID")).toBeGreaterThan(errorIndex);
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

  it("getScriptResult slices a string result's text server-side", async () => {
    const stream = bornStream();
    const harness = await makeProcessor({ stream });
    const text = "the quick brown fox jumps over the lazy dog";
    await stream.append({
      type: "events.iterate.com/capability-host/script-run-settled",
      idempotencyKey: "capability-host/script-run-settled@exec-str",
      payload: { executionId: "exec-str", settlement: { status: "succeeded", result: text } },
    });
    await harness.runner.catchUp();

    await expect(harness.processor.getScriptResult("exec-str", { slice: [4, 9] })).resolves.toEqual(
      {
        executionId: "exec-str",
        data: "quick",
        slicedFrom: { totalChars: text.length, start: 4, end: 9 },
      },
    );
    // end defaults to the end of the text
    await expect(harness.processor.getScriptResult("exec-str", { slice: [35] })).resolves.toEqual({
      executionId: "exec-str",
      data: "lazy dog",
      slicedFrom: { totalChars: text.length, start: 35, end: text.length },
    });
    // unsliced stays the full untouched value
    await expect(harness.processor.getScriptResult("exec-str")).resolves.toEqual({
      executionId: "exec-str",
      data: text,
    });
  });

  it("getScriptResult slices a JSON result as its pretty-printed text — the same text the workspace spill file holds", async () => {
    const stream = bornStream();
    const harness = await makeProcessor({ stream });
    const result = { users: [{ name: "amy" }, { name: "bob" }] };
    await stream.append({
      type: "events.iterate.com/capability-host/script-run-settled",
      idempotencyKey: "capability-host/script-run-settled@exec-json",
      payload: { executionId: "exec-json", settlement: { status: "succeeded", result } },
    });
    await harness.runner.catchUp();

    const canonical = JSON.stringify(result, null, 2);
    await expect(
      harness.processor.getScriptResult("exec-json", { slice: [0, 20] }),
    ).resolves.toEqual({
      executionId: "exec-json",
      data: canonical.slice(0, 20),
      slicedFrom: { totalChars: canonical.length, start: 0, end: 20 },
    });
  });

  it("getScriptResult slice clamps out-of-range and resolves negative offsets; malformed slices and failed scripts throw", async () => {
    const stream = bornStream();
    const harness = await makeProcessor({ stream });
    await stream.append(
      {
        type: "events.iterate.com/capability-host/script-run-settled",
        idempotencyKey: "capability-host/script-run-settled@exec-clamp",
        payload: {
          executionId: "exec-clamp",
          settlement: { status: "succeeded", result: "0123456789" },
        },
      },
      {
        type: "events.iterate.com/capability-host/script-run-settled",
        idempotencyKey: "capability-host/script-run-settled@exec-fail",
        payload: {
          executionId: "exec-fail",
          settlement: {
            status: "failed",
            error: "boom",
            failureKind: "runtime",
            phase: "execution",
            executionMayHaveOccurred: true,
            cancellation: "external-work-may-continue",
          },
        },
      },
    );
    await harness.runner.catchUp();

    // out-of-range clamps into [0, totalChars]
    await expect(
      harness.processor.getScriptResult("exec-clamp", { slice: [5, 999] }),
    ).resolves.toMatchObject({ data: "56789", slicedFrom: { totalChars: 10, start: 5, end: 10 } });
    // negatives count from the end, String.prototype.slice-style
    await expect(
      harness.processor.getScriptResult("exec-clamp", { slice: [-3] }),
    ).resolves.toMatchObject({ data: "789", slicedFrom: { totalChars: 10, start: 7, end: 10 } });
    // an inverted range serves the empty page at the resolved start
    await expect(
      harness.processor.getScriptResult("exec-clamp", { slice: [8, 2] }),
    ).resolves.toMatchObject({ data: "", slicedFrom: { totalChars: 10, start: 8, end: 8 } });
    // malformed slice tuples reject loudly instead of guessing
    await expect(harness.processor.getScriptResult("exec-clamp", { slice: [1.5] })).rejects.toThrow(
      '"slice" must be [start] or [start, end] with integer offsets',
    );
    // a failed script throws the same way sliced as unsliced
    await expect(harness.processor.getScriptResult("exec-fail", { slice: [0, 5] })).rejects.toThrow(
      'script execution "exec-fail" failed: boom',
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
