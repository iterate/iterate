import {
  initialAgentUiState,
  reduceAgentUi,
  type AgentUiActivity,
  type AgentUiState,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import { StreamProcessor } from "../../../stream-processor.ts";
import type { StreamEvent } from "../../../schemas.ts";
import { createSchemaEnsurer } from "../../browser/ensure-schema-once.ts";
import { ensureBrowserProcessorProgressSchema } from "../../browser/processor-state-storage.ts";
import { BrowserProjectionWriteBuffer } from "../../browser/projection-write-buffer.ts";
import type { SqlClient, SqlValue } from "../../browser/stream-browser-db.ts";
import { BrowserFeedContract } from "./contract.ts";
import {
  planBrowserFeedOps,
  RAW_GROUP_KIND,
  isAgentActivity,
  type BrowserFeedState,
  type FeedOp,
} from "./projector.ts";
export { BrowserFeedContract } from "./contract.ts";
export { BROWSER_FEED_SCHEMA_VERSION } from "./projector.ts";
export type { BrowserFeedState };

/** The table this processor owns — the ONLY rendered-feed table in the mirror. */
export const BROWSER_FEED_TABLE = "feed_items";

type VolatileAgentState = { state: AgentUiState; throughOffset: number };

/**
 * Folds stream events into the single `feed_items` projection for the browser
 * feed UI. The projection logic lives in the pure `planBrowserFeedOps` helper,
 * run one event at a time by BOTH hooks — `reduce` keeps its `endState`,
 * `processEvent` keeps its `ops` — so state and projection stay in lockstep by
 * construction. The ops are buffered into {@link projectionBuffer}; the
 * browser progress store (processor-state-storage.ts) flushes them and the
 * two-cursor progress record in ONE SQLite transaction per delivered frame.
 *
 * The open raw-group row grows with every folded event; its per-event ops are
 * COALESCED in the buffer to one upsert per commit carrying the row's final
 * data (matching the legacy batch override's one-statement-per-touched-row
 * serialization cost — without it a monotype catch-up would serialize the
 * group's cumulative events array once per event, O(n²) bytes on the exact
 * deep-replay path the mirror's flow control protects).
 */
export class BrowserFeedProcessor extends StreamProcessor<BrowserFeedContract, { sql: SqlClient }> {
  readonly contract = BrowserFeedContract;
  #volatileAgentState: VolatileAgentState | null = null;
  readonly #pendingActivityRows = new Map<
    number,
    { activity: AgentUiActivity; sourceOffset: number }
  >();

  /** Shared with the progress store — see the class doc. One per instance. */
  readonly projectionBuffer = new BrowserProjectionWriteBuffer();

  /** Projection schema for the progress store's first-open (prepare() successor). */
  ensureProjectionSchema(sql: SqlClient): Promise<void> {
    return ensureBrowserFeedSchema(sql);
  }

  /**
   * Build (without publishing) the transient agent-tail candidate for one
   * genuinely live frame. The durable runners still receive only durable
   * events; this overlay folds the original event order so a chunk before a
   * completion cannot be replayed after that completion. A frame with no
   * ephemeral event starts no overlay, while later durable frames continue an
   * already-live overlay until reconnect clears it.
   */
  prepareVolatileFrame(args: {
    events: readonly StreamEvent[];
    persistedState: unknown;
    persistedThroughOffset: number;
    scannedThroughOffset: number;
  }): VolatileAgentState | null {
    if (
      this.#volatileAgentState === null &&
      !args.events.some((event) => event.ephemeral === true)
    ) {
      return null;
    }
    const persistedState = BrowserFeedContract.stateSchema.parse(args.persistedState);
    let state = this.#volatileAgentState?.state ?? persistedState.agent;
    const afterOffset = this.#volatileAgentState?.throughOffset ?? args.persistedThroughOffset;
    for (const event of args.events) {
      if (event.offset <= afterOffset) continue;
      state = reduceAgentUi(
        state,
        event as unknown as Parameters<typeof reduceAgentUi>[1],
      ).endState;
    }
    return {
      state,
      throughOffset: Math.max(afterOffset, args.scannedThroughOffset),
    };
  }

  commitVolatileFrame(candidate: VolatileAgentState | null): void {
    if (candidate !== null) this.#volatileAgentState = candidate;
  }

  get volatileAgentUiState(): AgentUiState | null {
    return this.#volatileAgentState?.state ?? null;
  }

  clearVolatileState(): void {
    this.#volatileAgentState = null;
  }

  protected override reduce(
    args: Parameters<StreamProcessor<BrowserFeedContract>["reduce"]>[0],
  ): BrowserFeedState {
    return planBrowserFeedOps(args.state, [args.event]).endState;
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<BrowserFeedContract>["processEvent"]>[0],
  ): undefined {
    const { ops } = planBrowserFeedOps(args.previousState, [args.event]);
    // A drained buffer means a new frame has started. Pending rows exist only
    // to make late corrections inside ONE uncommitted frame visible; SQLite
    // is authoritative after the preceding frame commits.
    if (this.projectionBuffer.pendingCount === 0) this.#pendingActivityRows.clear();

    const executionId =
      args.event.type === "events.iterate.com/capability-host/script-run-settled"
        ? readExecutionId(args.event.payload)
        : null;
    const alreadyCorrected =
      executionId !== null &&
      ops.some(
        (op) =>
          op.kind === "replace" &&
          isAgentActivity(op.data) &&
          activityHasDurableExecution(op.data, executionId),
      );
    if (executionId !== null && !alreadyCorrected) {
      args.blockProcessorWhile(async () => {
        const correction = await this.#findPrunedActivityCorrection(args.event, executionId);
        this.#appendOps(
          args.event.offset,
          correction === null ? ops : [...ops, correction],
          args.state.open,
        );
      });
      return;
    }
    this.#appendOps(args.event.offset, ops, args.state.open);
  }

  #appendOps(offset: number, ops: readonly FeedOp[], open: BrowserFeedState["open"]): void {
    if (ops.length === 0) return;
    for (const op of ops) {
      if ((op.kind === "insert" || op.kind === "replace") && isAgentActivity(op.data)) {
        this.#pendingActivityRows.set(op.localIndex, { activity: op.data, sourceOffset: offset });
      }
    }
    this.projectionBuffer.append(
      offset,
      ops.map((op) => {
        if (op.kind === "replace" || open === null || op.localIndex !== open.localIndex) {
          // Settled rows (agent items, raw singletons, groups closed within
          // this event): one immutable statement each.
          return { build: () => feedOpToStatement(op) };
        }
        // The still-open raw group row. Always written as the UPSERT shape
        // with the row's FULL current values: a pending same-key write may be
        // the row's original insert (which a plain UPDATE must not replace —
        // the row would never be created), and against an already-committed
        // row the upsert's conflict arm is exactly the legacy UPDATE.
        const upsert: FeedOp =
          op.kind === "insert"
            ? op
            : {
                kind: "insert",
                localIndex: op.localIndex,
                itemKind: RAW_GROUP_KIND,
                firstOffset: open.firstOffset,
                lastOffset: op.lastOffset,
                eventCount: op.eventCount,
                data: op.data,
              };
        return {
          coalesceKey: `feed-item:${op.localIndex}`,
          build: () => feedOpToStatement(upsert),
        };
      }),
    );
  }

  async #findPrunedActivityCorrection(
    event: StreamEvent,
    executionId: string,
  ): Promise<FeedOp | null> {
    const pending = findInferredActivityRow(
      new Map(
        [...this.#pendingActivityRows].map(([localIndex, row]) => [localIndex, row.activity]),
      ),
      executionId,
    );
    const matched = pending ?? (await readInferredActivityRow(this.deps.sql, executionId));
    if (matched === null) return null;
    const start = initialAgentUiState();
    const reduced = reduceAgentUi(
      { ...start, provisionalActivities: { [matched.activity.id]: matched.activity } },
      event as unknown as Parameters<typeof reduceAgentUi>[1],
    );
    const corrected = reduced.items.find(
      (item): item is AgentUiActivity =>
        item.kind === "activity" && item.id === matched.activity.id,
    );
    if (corrected === undefined) return null;
    return {
      kind: "replace",
      localIndex: matched.localIndex,
      itemKind: `agent.${corrected.kind}`,
      lastOffset: event.offset,
      data: corrected,
    };
  }
}

function activityHasDurableExecution(activity: AgentUiActivity, executionId: string): boolean {
  return activity.steps.some(
    (step) =>
      step.kind === "code" && step.executionId === executionId && step.outcomeSource === "durable",
  );
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

export const ensureBrowserFeedSchema = createSchemaEnsurer({
  run: async (sql) => {
    // The rewind statements below reference processor_progress; make sure the
    // progress schema exists before the reset transaction can touch it.
    await ensureBrowserProcessorProgressSchema(sql);
    // No PRAGMA user_version here: feed_items shares the per-stream OPFS
    // database with the raw-events `events` table, which owns user_version.
    // Version resets ride the store's resetOnSchemaVersionChange lane
    // (mirror meta keyed by slug) instead.
    //
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
