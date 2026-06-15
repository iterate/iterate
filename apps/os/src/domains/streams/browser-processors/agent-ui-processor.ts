// The browser-hosted "agent-ui" processor: folds an agent stream — including
// partial LLM streaming chunks — into the clean chat the agent feed renders.
//
// A deliberate sibling of `browser-event-feed` (apps/os/src/domains/streams/engine): settled
// items are written into the `agent_feed_items` SQLite table (one row per
// list position, read by the TanStack virtual list); the reduced state holds
// only the in-flight activity with streaming thinking/response text plus the
// presence roster, persisted on every checkpoint so the UI can render the
// live tail reactively from `processor_state`.

import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/shared/streams/stream-processors";
import type { Event } from "@iterate-com/shared/streams/types";
import {
  initialAgentUiState,
  planAgentUiOps,
  type AgentUiOp,
  type AgentUiState,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import { createSchemaEnsurer } from "~/domains/streams/engine/browser/ensure-schema-once.ts";
import type { SqlClient, SqlValue } from "~/domains/streams/engine/browser/stream-browser-db.ts";
import { StreamProcessor } from "~/domains/streams/engine/stream-processor.ts";

/** The table this processor owns. */
export const AGENT_UI_FEED_TABLE = "agent_feed_items";

/** Bumped into the writer-lock name so a schema change lets a fresh tab take over. */
export const AGENT_UI_SCHEMA_VERSION = 4;

const AgentUiProcessorContractBase = defineProcessorContract({
  slug: "agent-ui",
  version: "0.1.0",
  description:
    "Browser-side processor that folds agent streams (including partial LLM chunks) into settled chat rows in SQLite plus a live in-flight activity in reduced state.",
  stateSchema: z
    .custom<AgentUiState>((value) => value != null && typeof value === "object")
    .default(initialAgentUiState),
  events: {
    "events.iterate.com/agent-ui/any-event": {
      description: "Synthetic catch-all to satisfy the consumes type constraint.",
      payloadSchema: z.unknown(),
    },
  },
  consumes: ["events.iterate.com/agent-ui/any-event"],
  emits: [],
});

export const AgentUiProcessorContract = Object.assign(AgentUiProcessorContractBase, {
  consumesAllEvents: true as const,
});

export type AgentUiProcessorContract = typeof AgentUiProcessorContract;

export type AgentUiProcessorDeps = {
  sql: SqlClient;
};

export class AgentUiProcessor extends StreamProcessor<
  AgentUiProcessorContract,
  AgentUiProcessorDeps
> {
  readonly contract = AgentUiProcessorContract;

  protected override async prepare(): Promise<void> {
    await ensureAgentUiSchema(this.deps.sql);
  }

  protected override reduce(
    args: Parameters<StreamProcessor<AgentUiProcessorContract>["reduce"]>[0],
  ): AgentUiState {
    return planAgentUiOps(args.state, [args.event as unknown as Event]).endState;
  }

  protected override async processEventBatch(
    args: Parameters<StreamProcessor<AgentUiProcessorContract>["processEventBatch"]>[0],
  ): Promise<void> {
    const { ops } = planAgentUiOps(args.previousState, args.events as unknown as Event[]);

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
