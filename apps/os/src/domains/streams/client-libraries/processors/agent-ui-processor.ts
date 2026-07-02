// The browser-hosted "agent-ui" processor: folds an agent stream — including
// partial LLM streaming chunks — into the clean chat the agent feed renders.
//
// A deliberate sibling of `browser-event-feed` (../processors/browser-event-feed):
// settled items are written into the `agent_feed_items` SQLite table (one row per
// list position, read by the TanStack virtual list); the reduced state holds
// only the in-flight activity with streaming thinking/response text plus the
// presence roster, persisted on every checkpoint so the UI can render the
// live tail reactively from `processor_state`.

import { z } from "zod";
import {
  initialAgentUiState,
  planAgentUiOps,
  type AgentUiOp,
  type AgentUiState,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import { defineProcessorContract, StreamProcessor } from "../../stream-processor.ts";
import { createSchemaEnsurer } from "../browser/ensure-schema-once.ts";
import type { SqlClient, SqlValue } from "../browser/stream-browser-db.ts";

/** The table this processor owns. */
export const AGENT_UI_FEED_TABLE = "agent_feed_items";

/** Bumped into the writer-lock name so a schema change lets a fresh tab take over. */
export const AGENT_UI_SCHEMA_VERSION = 4;

// planAgentUiOps still types its events against packages/ui's shared Event
// type; deriving the parameter type here keeps this file free of
// @iterate-com/shared imports until the ui package moves to the itx
// event model.
type AgentUiReducerEvents = Parameters<typeof planAgentUiOps>[1];

export const AgentUiProcessorContract = defineProcessorContract({
  slug: "agent-ui",
  version: "0.1.1",
  description:
    "Browser-side processor that folds agent streams (including partial LLM chunks) into settled chat rows in SQLite plus a live in-flight activity in reduced state.",
  // itx derives a processor's empty fold from `stateSchema.parse({})`
  // (there is no separate `initialState`), so the schema spreads
  // initialAgentUiState() under whatever was persisted — parse({}) IS the
  // initial state, and a persisted snapshot passes through unchanged.
  stateSchema: z.preprocess(
    (value) => ({ ...initialAgentUiState(), ...(value as object) }),
    z.custom<AgentUiState>((value) => value !== null && typeof value === "object"),
  ),
  events: {},
  consumes: ["*"],
  emits: [],
});

export type AgentUiProcessorContract = typeof AgentUiProcessorContract;

export class AgentUiProcessor extends StreamProcessor<
  AgentUiProcessorContract,
  { sql: SqlClient }
> {
  readonly contract = AgentUiProcessorContract;

  protected override async prepare(): Promise<void> {
    await ensureAgentUiSchema(this.deps.sql);
  }

  protected override reduce(
    args: Parameters<StreamProcessor<AgentUiProcessorContract>["reduce"]>[0],
  ): AgentUiState {
    return planAgentUiOps(args.state, [args.event] as unknown as AgentUiReducerEvents).endState;
  }

  protected override async processEventBatch(
    args: Parameters<StreamProcessor<AgentUiProcessorContract>["processEventBatch"]>[0],
  ): Promise<void> {
    const { ops } = planAgentUiOps(
      args.previousState,
      args.events as unknown as AgentUiReducerEvents,
    );

    if (ops.length > 0) {
      await this.deps.sql.batch(ops.map(agentUiOpToStatement), { transaction: true });
    }

    await super.processEventBatch(args);
  }
}

function agentUiOpToStatement(op: AgentUiOp): { sql: string; params: SqlValue[] } {
  return {
    sql: `INSERT INTO agent_feed_items (local_index, kind, data)
          VALUES (?, ?, jsonb(?))
          ON CONFLICT(local_index) DO UPDATE SET kind = excluded.kind, data = excluded.data`,
    params: [op.localIndex, op.item.kind, JSON.stringify(op.item)],
  };
}

const ensureAgentUiSchema = createSchemaEnsurer({
  run: async (sql) => {
    // No PRAGMA user_version here: agent_feed_items shares the per-stream OPFS
    // database with the raw-events `events` table, which owns user_version.
    await sql.batch(
      [
        {
          sql: `
            -- One row per settled agent feed item (user message, assistant
            -- message, or a completed activity with its steps). local_index is
            -- the dense, zero-based list position TanStack Virtual indexes.
            CREATE TABLE IF NOT EXISTS agent_feed_items (
              local_index INTEGER PRIMARY KEY,
              kind TEXT NOT NULL,
              data BLOB NOT NULL
            )
          `,
        },
      ],
      { transaction: true },
    );
  },
});
