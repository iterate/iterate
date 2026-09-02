// Child half of oversized-settlement-crash.test.ts: replays the 2026-09-02
// stream-DO death inside a process capped at the production isolate's memory
// budget (the parent spawns this under --max-old-space-size). Run directly:
//
//   node --max-old-space-size=128 --import tsx oversized-settlement-crash.child.ts <resultChars>
//
// Everything here is real product code — the settlement journals through
// scriptCompletionInput (the append-side choke point, so a fix that bounds
// settlements there changes THIS process's fate), lands in the real
// chunk-blob StreamEventLog over node:sqlite, and is then re-materialized by
// the same readers the production trace shows sharing the dead DO's isolate:
// six subscription-cursor reads, the two processor folds' own page reads,
// the capability-host fold's retained-result classification, and the agent
// fold's render stringifications (posthog capture is one of the six cursors).
// Each reader's product stays referenced (in-flight sends hold theirs in the
// DO) so the copies coexist, exactly like the incident.
//
// Prints one SURVIVED line and exits 0 when the budget holds. When it does
// not, V8 aborts the process: "FATAL ERROR: Reached heap limit Allocation
// failed - JavaScript heap out of memory" — the node spelling of the
// production reset.
import { DatabaseSync } from "node:sqlite";
import type { StreamEvent } from "iterate/processors";
import type { ScriptExecutionSettlement } from "@iterate-com/shared/script-execution";
import { stringifyScriptResult, truncateScriptResult } from "../../lib/script-result-render.ts";
import { retainedScriptResult } from "../capability-host/capability-host-preamble.ts";
import { scriptCompletionInput } from "../capability-host/script-execution-settlement.ts";
import { StreamEventLog, type SizedStreamEvent } from "./stream-storage.ts";

// Same SqlStorage wrapper as stream-storage.test.ts — node:sqlite standing in
// for the DO's SQLite, feeding the real StreamEventLog.
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

const resultChars = Number(process.argv[2]);
if (!Number.isFinite(resultChars) || resultChars < 1) {
  throw new Error(
    `usage: oversized-settlement-crash.child.ts <resultChars>, got ${process.argv[2]}`,
  );
}

const PATH = "/agents/web/repro";
const EXECUTION_ID = "agent-output:2373";
const log = new StreamEventLog(wrapSqlStorage(new DatabaseSync(":memory:")), PATH);

// The incident's payload shape: one giant base64 string in sandbox stdout.
const settlement: ScriptExecutionSettlement = {
  status: "succeeded",
  result: { stdout: `__FILE_1__\n${"iVBORw0KGgo".repeat(Math.ceil(resultChars / 11))}` },
};
const completion = scriptCompletionInput({
  executionId: EXECUTION_ID,
  idempotencyKey: `capability-host/script-run-settled@${EXECUTION_ID}`,
  settlement,
});
const settledEvent: StreamEvent = {
  type: completion.type,
  idempotencyKey: completion.idempotencyKey,
  payload: completion.payload,
  offset: 2381,
  createdAt: "2026-09-02T11:36:57.000Z",
  path: PATH,
};
log.insert([
  {
    type: "events.iterate.com/capability-host/script-run-requested",
    payload: { executionId: EXECUTION_ID, code: "async () => cropTheImage()", expiresAt: 0 },
    offset: 2373,
    createdAt: "2026-09-02T11:36:52.000Z",
    path: PATH,
  },
  settledEvent,
]);

// The fan-out. `retained` keeps every reader's product alive together.
const retained: unknown[] = [];
const readWholeWindow = () =>
  log.getRangeSized({ afterOffset: 0, beforeOffset: Number.MAX_SAFE_INTEGER, limit: 500 });

// Six durable-delivery subscription cursors (the dead DO's subscription_cursors
// table held six rows). A delivery is read + serialize + send: each cursor
// holds both its materialized batch AND the serialized send body until the
// receiver acknowledges, so all six pairs coexist during the catch-up burst.
for (let cursor = 0; cursor < 6; cursor++) {
  const batch = readWholeWindow();
  retained.push({ batch, sendBody: JSON.stringify(batch.map((sized) => sized.event)) });
}
// The two processor facets (agent + capability-host) page the same window
// through their own runner reads.
const agentFoldPage: SizedStreamEvent[] = readWholeWindow();
const hostFoldPage: SizedStreamEvent[] = readWholeWindow();
retained.push(agentFoldPage, hostFoldPage);

// Capability-host fold: classify the settlement into its retained row.
const foldedSettlement = (
  hostFoldPage.at(-1)!.event.payload as { settlement: ScriptExecutionSettlement }
).settlement;
retained.push(
  retainedScriptResult({
    executionId: EXECUTION_ID,
    scriptOffset: 2373,
    settledAtOffset: 2381,
    settlement: foldedSettlement,
  }),
);

// Agent fold render (renderScriptSettlement's allocations): the pretty text,
// the compact-JSON preamble-access measurement, and the truncated inline copy.
const agentSettlement = (
  agentFoldPage.at(-1)!.event.payload as { settlement: ScriptExecutionSettlement }
).settlement;
if (agentSettlement.status === "succeeded" && agentSettlement.result !== undefined) {
  const text = stringifyScriptResult(agentSettlement.result);
  retained.push(text, JSON.stringify(agentSettlement.result), truncateScriptResult(text, 30_000));
}

console.log(
  `SURVIVED readers=${retained.length} heapUsedMb=${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}`,
);
