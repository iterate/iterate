// The "middle option" repro: the same 2026-09-02 stream-DO death, but driven
// through the REAL stream-processing machinery instead of the hand-rolled
// reads in oversized-settlement-crash.child.ts. The fan-out here is genuine:
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
// Run directly under the isolate budget:
//   node --max-old-space-size=96 --import tsx oversized-settlement-crash-realprocessors.child.ts <resultChars>
//
// Prints one SURVIVED line and exits 0 when the budget holds; otherwise V8
// aborts ("Reached heap limit … out of memory") — the node spelling of the
// production isolate reset.
import { DatabaseSync } from "node:sqlite";
import { StreamProcessorRunner } from "iterate/processors";
import type {
  ProcessorStream,
  StreamEvent,
  StreamEventInput,
  StreamEventReadInput,
} from "iterate/processors";
import type { ScriptExecutionSettlement } from "@iterate-com/shared/script-execution";
import type { Project } from "../../itx-api.generated.ts";
import { AgentProcessor } from "../agents/agent-processor-implementation.ts";
import type { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { CapabilityHostProcessor } from "../capability-host/capability-host-processor-implementation.ts";
import type { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { scriptCompletionInput } from "../capability-host/script-execution-settlement.ts";
import { StreamEventLog } from "./stream-storage.ts";

// node:sqlite standing in for the DO's ctx.storage.sql, same shim the storage
// tests use.
function wrapSqlStorage(db: DatabaseSync): SqlStorage {
  return {
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
  } as SqlStorage;
}

// The ~40-line adapter the wiring map called for: a ProcessorStream backed by
// a real StreamEventLog, so runner reads go through the genuine chunk re-parse
// rather than returning array references (which is what MemoryStream does, and
// why MemoryStream can't reproduce the per-read allocation).
class LogStream implements ProcessorStream {
  readonly streamId = "11111111-1111-4111-8111-111111111111";
  constructor(
    private readonly log: StreamEventLog,
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
  appendIfStreamId(args: { streamId: string; events: StreamEventInput[] }): Promise<StreamEvent[]> {
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

const resultChars = Number(process.argv[2]);
if (!Number.isFinite(resultChars) || resultChars < 1) {
  throw new Error(`usage: <resultChars>, got ${process.argv[2]}`);
}

const PATH = "/agents/web/repro";
const EXECUTION_ID = "agent-output:2373";
const log = new StreamEventLog(wrapSqlStorage(new DatabaseSync(":memory:")), PATH);
const stream = new LogStream(log, PATH);

// Seed the incident: the agent-scope birth events, the script obligation the
// agent requested, and the 7MB settlement — journaled through the real
// scriptCompletionInput, exactly as the capability host commits it.
const settlement: ScriptExecutionSettlement = {
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
  { type: "events.iterate.com/capability-host/created", payload: { config: {}, fallback: null } },
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
  { type: completion.type, idempotencyKey: completion.idempotencyKey, payload: completion.payload },
);

// Two REAL runners over the one stream — the agent facet and the capability-
// host facet, both resident as they are in the live DO. Each processor's
// `reads` closes over its own runner, the same wiring the processor tests use.
let capabilityRunner!: StreamProcessorRunner<CapabilityHostProcessorContract>;
const capabilityHost = new CapabilityHostProcessor({
  stream,
  path: PATH,
  projectId: null,
  itx: {} as Project,
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
// memory path) instead of spilling it to a workspace file. The agent processor
// takes no `reads` dep — its state comes from the runner's fold hooks.
const agent = new AgentProcessor({ stream, path: PATH, projectId: null });
const agentRunner: StreamProcessorRunner<AgentProcessorContract> = new StreamProcessorRunner({
  processor: agent,
  stream,
});

// Both facets fold the whole stream, concurrently. Their reduced states — each
// holding a materialized view of the 7MB settlement — stay referenced together.
const [capabilityState, agentState] = await Promise.all([
  capabilityRunner.catchUp().then(() => capabilityRunner.snapshot()),
  agentRunner.catchUp().then(() => agentRunner.snapshot()),
]);

// The delivery re-materialization: subscription cursors reading the same window
// through the real chunk re-parse (six rows on the dead DO). Held alive with
// their serialized send bodies, as in-flight deliveries are.
const deliveries = [];
for (let cursor = 0; cursor < 6; cursor++) {
  const batch = await stream.getEvents({ afterOffset: 0, limit: 500 });
  deliveries.push({ batch, sendBody: JSON.stringify(batch) });
}

const retained = { capabilityState, agentState, deliveries };
console.log(
  `SURVIVED facets=2 deliveries=${retained.deliveries.length} heapUsedMb=${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}`,
);
