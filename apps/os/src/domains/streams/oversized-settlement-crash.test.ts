// Reproduces the 2026-09-02 stream-DO death as an actual out-of-memory crash,
// driving the REAL stream-processing machinery. The fan-out is genuine:
//
//   - a real StreamEventLog (chunk-blob storage over node:sqlite) holds the
//     events; every read re-parses the chunks (JSON.parse + schema parse),
//     the real per-read allocation;
//   - a ~ProcessorStream adapter over that log feeds two REAL runners;
//   - a real CapabilityHostProcessor folds the 7MB script-run-settled event
//     (retainedScriptResult classification) and a real AgentProcessor folds
//     the same stream — the two facets that shared the dead DO's isolate;
//   - both runners' reduced states stay referenced at once, as they do in the
//     live DO where both facet folds are resident in one isolate.
//
// The repro body is the `reproduce` function below. It is fully self-contained
// (`@isolated`: every dependency is imported inside it or passed in), so
// `reproduce.toString()` is a complete module. `runReplay` writes it to a
// sibling *.ignoreme.ts (gitignored, same dir so its relative imports resolve),
// runs it in a child capped at the isolate memory budget, then deletes it.
//
// Node heap (--max-old-space-size) stands in for the workerd 128MiB isolate
// cap, shared in production with the agent's contextItems, connections, and the
// ephemeral buffer, so the fan-out never had a full 128MiB to itself.
//
// Measured splits (deterministic, three repeats each):
//   incident (~7.3M chars) → V8 aborts: "Ineffective mark-compacts … out of memory"
//   control  (3k chars)    → SURVIVED, ~43MB heap
// Same body both runs; only the payload size differs, so the crash is caused by
// the unbounded settlement and nothing else.
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { failing } from "@iterate-com/shared/test-support/failing-test";

const ISOLATE_BUDGET_MB = 96;
const INCIDENT_CHARS = 7_260_000; // the prod settlement was 7,051KB
const CONTROL_CHARS = 3_000;

// Every V8 out-of-memory spelling — the node stand-in for the isolate reset.
// A heap blow-up surfaces as any of these depending on where GC gives up.
const OOM_SIGNATURE =
  /Reached heap limit|JavaScript heap out of memory|Ineffective mark-compacts|Allocation failed/;

describe("stream DO isolate under an oversized settlement (real processors)", () => {
  // Guard rail: the real folds + deliveries over a small settlement fit the
  // budget comfortably. If this fails, the fixture is what OOMs, not the bug.
  test("survives comfortably when the settlement is small", { timeout: 10_000 }, () => {
    const control = runReplay(CONTROL_CHARS);
    expect(control.kind).toBe("survived");
    expect(control.output).toContain("SURVIVED");
  });

  // Pinned prod incident: StreamDurableObject 50703abf…d9e01 (os-prd). The
  // real AgentProcessor + CapabilityHostProcessor folds re-materialize the 7MB
  // settlement (reduceAgentEvent render + retainedScriptResult classification)
  // and OOM the isolate — "Durable Object's isolate exceeded its memory limit
  // and was reset" (traces 2f4ac441… / 78d9c657…), then wake-looped for hours.
  //
  // Desired behavior: the fold fan-out fits the budget because the settlement
  // was bounded before it was journaled. Today it OOMs.
  //
  // One assertion carries all three outcomes; the `Incident kind: <kind>` label
  // in its failure message is what the pin keys on:
  // - oom (bug present)    → no SURVIVED, assertion fails, message says
  //                          "Incident kind: oom" → matches → pin green.
  // - survived (bug fixed) → SURVIVED present, assertion passes, body succeeds
  //                          → failing() flips red: delete the wrapper.
  // - other-failure        → no SURVIVED, but the message says "Incident kind:
  //   (import error, etc.)   other-failure" → does NOT match → failing() reports
  //                          red. A child abort that is not a real OOM proves
  //                          nothing and must not hold the pin.
  const failOOM = failing(test, /Incident kind: oom/);
  failOOM("survives the real folds re-materializing an oversized settlement", () => {
    const incident = runReplay(INCIDENT_CHARS);
    const message = `Incident kind: ${incident.kind}. Budget: ${ISOLATE_BUDGET_MB}MB. Output:\n${incident.output.slice(-500)}`;
    expect(incident.output, message).toContain("SURVIVED");
  });
});

// The reproduction body. `@isolated` (enforced by unicorn-js/isolated-functions)
// guarantees it references nothing from this module's scope — every dependency
// is imported inside via `await import`, so `.toString()` yields a runnable,
// self-contained module. Types come through local `import(...)` aliases, which
// the lint rule ignores and the transpiler strips.
//
// @isolated -- materialized to disk and run as its own module; keep it closed
const reproduce = async ({ resultChars }: { resultChars: number }): Promise<void> => {
  // Multi-use local type aliases (the single-use ones are inlined at their use
  // sites, per the colocate-single-use-types rule). Inline `import(...)` types
  // keep the body self-contained; the lint rule ignores them and the
  // transpiler strips them.
  type ProcessorStream = import("iterate/processors").ProcessorStream;
  type StreamEvent = import("iterate/processors").StreamEvent;
  type StreamEventInput = import("iterate/processors").StreamEventInput;
  type StreamEventReadInput = import("iterate/processors").StreamEventReadInput;

  const { DatabaseSync } = await import("node:sqlite");
  const { memoryUsage } = await import("node:process");
  const { StreamProcessorRunner } = await import("iterate/processors");
  const { AgentProcessor } = await import("../agents/agent-processor-implementation.ts");
  const { CapabilityHostProcessor } =
    await import("../capability-host/capability-host-processor-implementation.ts");
  const { scriptCompletionInput } =
    await import("../capability-host/script-execution-settlement.ts");
  const { StreamEventLog } = await import("./stream-storage.ts");

  // node:sqlite standing in for the DO's ctx.storage.sql, same shim the storage
  // tests use.
  const wrapSqlStorage = (db: InstanceType<typeof DatabaseSync>): SqlStorage =>
    ({
      exec<T = unknown>(sql: string, ...bindings: (ArrayBuffer | null | number | string)[]) {
        const rows = db
          .prepare(sql)
          .all(
            ...bindings.map((binding) =>
              binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
            ),
          )
          .map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([key, value]) => [
                key,
                value instanceof Uint8Array
                  ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
                  : value,
              ]),
            ),
          );
        return { toArray: () => rows as T[] };
      },
    }) as SqlStorage;

  // A ProcessorStream backed by a real StreamEventLog, so runner reads go
  // through the genuine chunk re-parse rather than returning array references
  // (which is what MemoryStream does, and why it can't reproduce the per-read
  // allocation).
  class LogStream implements ProcessorStream {
    readonly streamId = "11111111-1111-4111-8111-111111111111";
    constructor(
      private readonly log: InstanceType<typeof StreamEventLog>,
      readonly path: string,
    ) {}

    async append(...inputs: StreamEventInput[]): Promise<StreamEvent[]> {
      let offset = this.log.highestOffset();
      const events: StreamEvent[] = inputs.map((input) => ({
        ...input,
        createdAt: new Date(0).toISOString(),
        offset: ++offset,
        path: this.path,
      }));
      this.log.insert(events);
      return events;
    }
    appendIfStreamId(args: {
      streamId: string;
      events: StreamEventInput[];
    }): Promise<StreamEvent[]> {
      if (args.streamId !== this.streamId) throw new Error("stream id changed");
      return this.append(...args.events);
    }
    async getEvents(input: StreamEventReadInput = {}): Promise<StreamEvent[]> {
      return this.log.getRange({
        afterOffset: input.afterOffset ?? 0,
        beforeOffset: input.beforeOffset ?? Number.MAX_SAFE_INTEGER,
        eventTypes: input.eventTypes,
        limit: input.limit ?? 500,
      });
    }
    async getEventPage(input: StreamEventReadInput = {}) {
      return {
        streamId: this.streamId,
        streamMaxOffset: this.log.highestOffset(),
        events: await this.getEvents(input),
      };
    }
    readEvents(input: StreamEventReadInput = {}) {
      let afterOffset = input.afterOffset ?? 0;
      const getEvents = this.getEvents.bind(this);
      return {
        async next() {
          const page = await getEvents({ ...input, afterOffset });
          afterOffset = page.at(-1)?.offset ?? afterOffset;
          return page;
        },
        [Symbol.dispose]() {},
      };
    }
    async getEvent(
      input: { offset: number } | { idempotencyKey: string },
    ): Promise<StreamEvent | undefined> {
      return "offset" in input
        ? this.log.getByOffset(input.offset)
        : this.log.getByIdempotencyKey(input.idempotencyKey);
    }
    at(): ProcessorStream {
      return this;
    }
  }

  const PATH = "/agents/web/repro";
  const EXECUTION_ID = "agent-output:2373";
  const log = new StreamEventLog(wrapSqlStorage(new DatabaseSync(":memory:")), PATH);
  const stream = new LogStream(log, PATH);

  // Seed the incident: the agent-scope birth events, the script obligation the
  // agent requested, and the 7MB settlement — journaled through the real
  // scriptCompletionInput, exactly as the capability host commits it.
  const settlement: import("@iterate-com/shared/script-execution").ScriptExecutionSettlement = {
    status: "succeeded",
    result: { stdout: `__FILE_1__\n${"iVBORw0KGgo".repeat(Math.ceil(resultChars / 11))}` },
  };
  const completion = scriptCompletionInput({
    executionId: EXECUTION_ID,
    idempotencyKey: `capability-host/script-run-settled@${EXECUTION_ID}`,
    settlement,
  });
  await stream.append(
    { type: "events.iterate.com/agent/created", payload: {} },
    {
      type: "events.iterate.com/agent/configured",
      payload: { config: { llm: { model: "test-model" } } },
    },
    {
      type: "events.iterate.com/capability-host/created",
      payload: { config: {}, fallback: null },
    },
    {
      type: "events.iterate.com/capability-host/script-run-requested",
      idempotencyKey: `capability-host/script-run-requested@${EXECUTION_ID}`,
      payload: { executionId: EXECUTION_ID, code: "async () => cropTheImage()", expiresAt: 1 },
    },
    {
      type: "events.iterate.com/capability-host/script-run-started",
      idempotencyKey: `capability-host/script-run-started@${EXECUTION_ID}`,
      payload: { executionId: EXECUTION_ID },
    },
    {
      type: completion.type,
      idempotencyKey: completion.idempotencyKey,
      payload: completion.payload,
    },
  );

  // Two REAL runners over the one stream — the agent facet and the capability-
  // host facet, both resident as they are in the live DO. The capability-host
  // `reads` closes over its own runner, the same wiring the processor tests use.
  let capabilityRunner!: import("iterate/processors").StreamProcessorRunner<
    import("../capability-host/capability-host-processor-contract.ts").CapabilityHostProcessorContract
  >;
  const capabilityHost = new CapabilityHostProcessor({
    stream,
    path: PATH,
    projectId: null,
    // A pure fold replay never dials itx or the script entrypoint; empty stubs.
    itx: {} as import("../../itx-api.generated.ts").Project,
    scriptExecutionEntrypoint: {
      run: () => {
        throw new Error("no script execution in a pure fold replay");
      },
    },
    reads: {
      snapshot: () => capabilityRunner.snapshot(),
      // The ternary splits the overloaded arg union so each branch matches one
      // overload — the same passthrough the processor test harnesses use.
      waitUntilEvent: (input) =>
        "offset" in input
          ? capabilityRunner.waitUntilEvent(input)
          : capabilityRunner.waitUntilEvent(input),
    },
  });
  capabilityRunner = new StreamProcessorRunner({ processor: capabilityHost, stream });

  // No callLlm/writeWorkspaceFile: a pure fold replay drives no model turn, and
  // dropping writeWorkspaceFile keeps an oversized render inline (the harsher
  // memory path) instead of spilling it. The agent takes no `reads` dep — its
  // state comes from the runner's fold hooks.
  const agent = new AgentProcessor({ stream, path: PATH, projectId: null });
  const agentRunner: import("iterate/processors").StreamProcessorRunner<
    import("../agents/agent-processor-contract.ts").AgentProcessorContract
  > = new StreamProcessorRunner({ processor: agent, stream });

  // Both facets fold the whole stream, concurrently. Their reduced states — each
  // a materialized view of the 7MB settlement — stay referenced together.
  const [capabilityState, agentState] = await Promise.all([
    capabilityRunner.catchUp().then(() => capabilityRunner.snapshot()),
    agentRunner.catchUp().then(() => agentRunner.snapshot()),
  ]);

  // The delivery re-materialization: subscription cursors reading the same
  // window through the real chunk re-parse (six rows on the dead DO), held alive
  // with their serialized send bodies as in-flight deliveries are.
  const deliveries = [];
  for (let cursor = 0; cursor < 6; cursor++) {
    const batch = await stream.getEvents({ afterOffset: 0, limit: 500 });
    deliveries.push({ batch, sendBody: JSON.stringify(batch) });
  }

  const retained = { capabilityState, agentState, deliveries };
  console.log(
    `SURVIVED facets=2 deliveries=${retained.deliveries.length} heapUsedMb=${Math.round(memoryUsage().heapUsed / 1024 / 1024)}`,
  );
};

type ReplayOutcome =
  | { kind: "survived"; output: string }
  | { kind: "oom"; output: string }
  | { kind: "other-failure"; output: string };

/** Materialize the isolated `reproduce` body to a sibling *.ignoreme.ts, run it
 * in a child capped at the isolate budget, classify the outcome, delete it.
 * Written to the same dir so the body's relative imports resolve. */
function runReplay(resultChars: number): ReplayOutcome {
  const modulePath = fileURLToPath(
    new URL("./oversized-settlement-crash.child.ignoreme.ts", import.meta.url),
  );
  // vitest transpiles the test module for its SSR runtime, so `.toString()`
  // rewrites the body for the vite dev server: `import(...)` becomes
  // `__vite_ssr_dynamic_import__(...)`, and import specifiers become dev-server
  // URLs — `/@fs/<abs>` for files outside the vite root (apps/os) and
  // `/<root-relative>` for files inside it. Undo all three so the child is a
  // plain module of absolute-path dynamic imports (tsx reads a leading-slash
  // specifier as a file path). node: specifiers pass through untouched.
  const appsOsRoot = fileURLToPath(new URL("../../../", import.meta.url)); // .../apps/os/
  const body = reproduce
    .toString()
    .replaceAll("__vite_ssr_dynamic_import__", "import")
    .replaceAll('import("/@fs/', 'import("/')
    .replaceAll('import("/src/', `import("${appsOsRoot}src/`);
  // Fail loudly if any dev-server artifact survived — a vite transform change
  // must break the test, not silently ship a broken child.
  for (const artifact of ["__vite_ssr", "/@fs/", "/@id/", 'import("/src/']) {
    if (body.includes(artifact)) {
      throw new Error(
        `unexpected vite artifact ${artifact} in reproduce body:\n${body.slice(0, 400)}`,
      );
    }
  }
  // The one argument is baked in as a JSON literal — no process.argv glue.
  writeFileSync(modulePath, `await (${body})(${JSON.stringify({ resultChars })});\n`);
  try {
    const output = execFileSync(
      process.execPath,
      [`--max-old-space-size=${ISOLATE_BUDGET_MB}`, "--import", "tsx", modulePath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 },
    );
    return { kind: "survived", output };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    return { kind: OOM_SIGNATURE.test(output) ? "oom" : "other-failure", output };
  } finally {
    rmSync(modulePath, { force: true });
  }
}
