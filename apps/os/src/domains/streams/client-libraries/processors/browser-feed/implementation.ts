import {
  initialAgentUiState,
  reduceAgentUi,
  type AgentUiActivity,
  type AgentUiState,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import { StreamProcessor } from "../../../stream-processor.ts";
import { createSchemaEnsurer } from "../../browser/ensure-schema-once.ts";
import type { SqlClient, SqlValue } from "../../browser/stream-browser-db.ts";
import { BrowserFeedContract } from "./contract.ts";
import {
  AGENT_KIND_PREFIX,
  isAgentActivity,
  planBrowserFeedOps,
  type BrowserFeedState,
  type FeedOp,
} from "./projector.ts";
export { BrowserFeedContract } from "./contract.ts";
export { BROWSER_FEED_SCHEMA_VERSION } from "./projector.ts";

/** The table this processor owns — the ONLY rendered-feed table in the mirror. */
export const BROWSER_FEED_TABLE = "feed_items";

export type { BrowserFeedState };

/**
 * Folds stream events into the single `feed_items` projection for the browser
 * feed UI. The projection logic lives in the pure `planBrowserFeedOps` helper:
 * `reduce` runs it one event at a time to advance state, and
 * `processEventBatch` runs it over the whole batch (from the same batch-entry
 * state) to produce one SQLite transaction — keeping the two in lockstep by
 * construction.
 */
export class BrowserFeedProcessor extends StreamProcessor<BrowserFeedContract, { sql: SqlClient }> {
  readonly contract = BrowserFeedContract;
  #volatileAgentState: AgentUiState | null = null;

  /**
   * Fold a genuinely live delivery into the transient agent tail while
   * persisting only durable events. Ephemeral chunks never enter the SQLite
   * projection or reduced state; the scan checkpoint may advance across their
   * consumed offsets so reconnects cannot replay them. Reconnecting
   * intentionally drops this memory.
   */
  async ingestLive(
    args: Parameters<StreamProcessor<BrowserFeedContract>["ingest"]>[0],
  ): Promise<void> {
    // A fresh browser processor can already have a complete SQLite checkpoint.
    // Load it before seeding the volatile tail, and ignore replay overlap from
    // a sibling processor whose (smaller) checkpoint selected the composite
    // subscription cursor. StreamProcessor.ingest applies the same overlap
    // rule to the durable projection below.
    const snapshot = await this.snapshot();
    let agent = this.#volatileAgentState ?? snapshot.state.agent;
    for (const event of args.events) {
      if (event.offset <= snapshot.offset) continue;
      agent = reduceAgentUi(
        agent,
        event as unknown as Parameters<typeof reduceAgentUi>[1],
      ).endState;
    }
    await super.ingest({
      ...args,
      events: args.events.filter((event) => event.ephemeral !== true),
    });
    this.#volatileAgentState = agent;
  }

  get agentUiState(): AgentUiState {
    return this.#volatileAgentState ?? this.state.agent;
  }

  clearVolatileState(): void {
    this.#volatileAgentState = null;
  }

  protected override async prepare(): Promise<void> {
    await ensureBrowserFeedSchema(this.deps.sql);
  }

  protected override reduce(
    args: Parameters<StreamProcessor<BrowserFeedContract>["reduce"]>[0],
  ): BrowserFeedState {
    return planBrowserFeedOps(args.state, [args.event]).endState;
  }

  protected override async processEventBatch(
    args: Parameters<StreamProcessor<BrowserFeedContract>["processEventBatch"]>[0],
  ): Promise<void> {
    const { ops } = planBrowserFeedOps(args.previousState, args.events);
    await appendPrunedActivityCorrections(this.deps.sql, ops, args.events);

    if (ops.length > 0) {
      await this.deps.sql.batch(ops.map(feedOpToStatement), { transaction: true });
    }

    await super.processEventBatch(args);
  }
}

/**
 * The reducer keeps only a bounded hot window of inferred script outcomes.
 * A completion that arrives after that window must still replace the
 * previously rendered row. Recover the current activity from SQLite (or from
 * an insert earlier in this same batch), run it through the canonical reducer,
 * and append a normal replace op. This keeps reducer memory bounded without
 * silently discarding late durable truth.
 */
async function appendPrunedActivityCorrections(
  sql: SqlClient,
  ops: FeedOp[],
  events: Parameters<StreamProcessor<BrowserFeedContract>["processEventBatch"]>[0]["events"],
): Promise<void> {
  const rows = new Map<number, AgentUiActivity>();
  const alreadyCorrected = new Set<string>();
  for (const op of ops) {
    if ((op.kind === "insert" || op.kind === "replace") && isAgentActivity(op.data)) {
      rows.set(op.localIndex, op.data);
      if (op.kind === "replace") {
        for (const step of op.data.steps) {
          if (step.kind === "code" && step.outcomeSource === "durable") {
            alreadyCorrected.add(step.executionId);
          }
        }
      }
    }
  }

  for (const event of events) {
    if (event.type !== "events.iterate.com/capability-host/script-execution-completed") continue;
    const executionId = readExecutionId(event.payload);
    if (executionId == null || alreadyCorrected.has(executionId)) continue;

    let matched = findInferredActivityRow(rows, executionId);
    // oxlint-disable-next-line react-doctor/async-await-in-loop -- corrections mutate the same ordered op list; serial lookup preserves event order and lets later completions observe earlier replacements.
    if (matched == null) matched = await readInferredActivityRow(sql, executionId);
    if (matched == null) continue;
    const { activity, localIndex } = matched;

    const start = initialAgentUiState();
    const reduced = reduceAgentUi(
      {
        ...start,
        provisionalActivities: { [activity.id]: activity },
      },
      event as unknown as Parameters<typeof reduceAgentUi>[1],
    );
    const corrected = reduced.items.find(
      (item): item is AgentUiActivity => item.kind === "activity" && item.id === activity.id,
    );
    if (corrected == null) continue;

    rows.set(localIndex, corrected);
    alreadyCorrected.add(executionId);
    ops.push({
      kind: "replace",
      localIndex,
      itemKind: `${AGENT_KIND_PREFIX}${corrected.kind}`,
      lastOffset: event.offset,
      data: corrected,
    });
  }
}

function findInferredActivityRow(
  rows: ReadonlyMap<number, AgentUiActivity>,
  executionId: string,
): { localIndex: number; activity: AgentUiActivity } | null {
  for (const [localIndex, activity] of rows) {
    if (
      activity.steps.some(
        (step) =>
          step.kind === "code" &&
          step.executionId === executionId &&
          step.outcomeSource === "inferred",
      )
    ) {
      return { localIndex, activity };
    }
  }
  return null;
}

async function readInferredActivityRow(
  sql: SqlClient,
  executionId: string,
): Promise<{ localIndex: number; activity: AgentUiActivity } | null> {
  const [row] = await sql.exec(
    `SELECT local_index, json(data) AS data
     FROM feed_items
     WHERE kind = 'agent.activity'
       AND EXISTS (
         SELECT 1
         FROM json_each(json_extract(data, '$.steps')) AS step
         WHERE json_extract(step.value, '$.kind') = 'code'
           AND json_extract(step.value, '$.executionId') = ?
           AND json_extract(step.value, '$.outcomeSource') = 'inferred'
       )
     ORDER BY local_index DESC
     LIMIT 1`,
    [executionId],
  );
  const localIndex = row?.local_index;
  const raw = row?.data;
  if (!Number.isSafeInteger(localIndex) || typeof raw !== "string") return null;
  try {
    const activity: unknown = JSON.parse(raw);
    return isAgentActivity(activity) ? { localIndex: localIndex as number, activity } : null;
  } catch {
    return null;
  }
}

function readExecutionId(payload: unknown): string | null {
  return payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    typeof (payload as Record<string, unknown>).executionId === "string"
    ? ((payload as Record<string, unknown>).executionId as string)
    : null;
}

function feedOpToStatement(op: FeedOp): { sql: string; params: SqlValue[] } {
  if (op.kind === "insert") {
    return {
      sql: `INSERT INTO feed_items (local_index, kind, first_offset, last_offset, event_count, data)
            VALUES (?, ?, ?, ?, ?, jsonb(?))
            ON CONFLICT(local_index) DO UPDATE SET
              kind = excluded.kind,
              first_offset = excluded.first_offset,
              last_offset = excluded.last_offset,
              event_count = excluded.event_count,
              data = excluded.data`,
      params: [
        op.localIndex,
        op.itemKind,
        op.firstOffset,
        op.lastOffset,
        op.eventCount,
        JSON.stringify(op.data),
      ],
    };
  }
  if (op.kind === "replace") {
    return {
      sql: `UPDATE feed_items SET kind = ?, last_offset = ?, data = jsonb(?) WHERE local_index = ?`,
      params: [op.itemKind, op.lastOffset, JSON.stringify(op.data), op.localIndex],
    };
  }
  return {
    sql: `UPDATE feed_items SET last_offset = ?, event_count = ?, data = jsonb(?) WHERE local_index = ?`,
    params: [op.lastOffset, op.eventCount, JSON.stringify(op.data), op.localIndex],
  };
}

const ensureBrowserFeedSchema = createSchemaEnsurer({
  run: async (sql) => {
    // No PRAGMA user_version here: feed_items shares the per-stream OPFS
    // database with the raw-events `events` table, which owns user_version.
    // Version resets ride the store's resetOnSchemaVersionChange lane
    // (mirror meta keyed by slug) instead.
    await sql.batch(
      [
        {
          sql: `
            -- One row per rendered Feed Item, pretty and raw interleaved in ONE
            -- total order: local_index is allocated by the browser-feed
            -- projector as items settle. kind is 'agent.<item kind>' for pretty
            -- chat rows (data = the AgentUiItem) or 'raw.group' /
            -- 'raw.<component>' for raw rows (data = the grouped events).
            CREATE TABLE IF NOT EXISTS feed_items (
              local_index INTEGER PRIMARY KEY,
              kind TEXT NOT NULL,
              first_offset INTEGER NOT NULL,
              last_offset INTEGER NOT NULL,
              event_count INTEGER NOT NULL DEFAULT 1,
              data BLOB NOT NULL
            )
          `,
        },
        {
          sql: `CREATE INDEX IF NOT EXISTS feed_items_offsets_idx ON feed_items (first_offset, last_offset)`,
        },
        {
          sql: `CREATE INDEX IF NOT EXISTS feed_items_kind_idx ON feed_items (kind, local_index)`,
        },
      ],
      { transaction: true },
    );
  },
});
