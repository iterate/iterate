import {
  AGENT_BINDING_SET_EVENT_TYPE,
  AGENT_METADATA_CHANGED_EVENT_TYPE,
  AGENT_RUNTIME_CHANGED_EVENT_TYPE,
  AGENT_WAITING_CLEARED_EVENT_TYPE,
  AgentRuntimeChange,
  AgentWaitingCleared,
  ZERO_AGENT_RUNTIME,
  agentRuntimesEqual,
  mergeAgentRuntimeChange,
} from "@iterate-com/shared/agent-events";
import { AgentBirthCertificate } from "../agents/agent-processor-contract.ts";
import {
  AgentBinding,
  AgentMetadata,
  AgentMetadataPatch,
  AgentPath,
  AgentRecord,
  applyAgentMetadataPatch,
  type AgentRecord as AgentRecordValue,
} from "../agents/agent-presence.ts";

const AGENT_CREATED_EVENT_TYPE = "events.iterate.com/agent/created";

export type AgentProjectionEvent = {
  type: string;
  payload: unknown;
  offset: number;
  createdAt: string;
};

export type AgentTouchInput = {
  path: string;
  events: AgentProjectionEvent[];
};

type StoredAgent = {
  record: AgentRecordValue;
  lastEventOffset: number;
  runtimeSinceOffset: number;
  waitingForSinceOffset?: number;
};

/**
 * The complete project agent projection. Agent journals remain the source of
 * truth; this SQLite slice is an idempotent materialization updated in
 * acknowledged processEventBatch delivery, with a stable copy-on-write public
 * map for live state diffs.
 */
export class AgentDatabase {
  readonly #sql: SqlStorage;
  #stored: Record<string, StoredAgent>;
  #projection: Record<string, AgentRecordValue>;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS agents (
        path TEXT PRIMARY KEY,
        record TEXT NOT NULL,
        last_event_offset INTEGER NOT NULL,
        runtime_since_offset INTEGER NOT NULL,
        waiting_for_since_offset INTEGER
      )`,
    );
    this.#stored = this.#load();
    this.#projection = Object.fromEntries(
      Object.entries(this.#stored).map(([path, stored]) => [path, stored.record]),
    );
  }

  /** Stable between public record changes. */
  all(): Record<string, AgentRecordValue> {
    return this.#projection;
  }

  /** Seed quiet agents from the project processor's complete created catalog.
   * A later direct agent/created fact with offset > 0 replaces the seed's
   * slightly later cross-post timestamp. */
  seedMissing(agents: readonly { path: string; createdAt: string }[]): void {
    let nextStored = this.#stored;
    let nextProjection = this.#projection;
    for (const agent of agents) {
      const path = AgentPath.parse(agent.path);
      if (nextStored[path] !== undefined) continue;
      const stored: StoredAgent = {
        record: createAgentRecord(path, agent.createdAt),
        lastEventOffset: 0,
        runtimeSinceOffset: 0,
      };
      this.#store(path, stored);
      if (nextStored === this.#stored) {
        nextStored = { ...this.#stored };
        nextProjection = { ...this.#projection };
      }
      nextStored[path] = stored;
      nextProjection[path] = stored.record;
    }
    this.#stored = nextStored;
    this.#projection = nextProjection;
  }

  /** Fold one committed agent-stream batch. Offsets make redelivery a no-op. */
  touch(input: AgentTouchInput): void {
    const path = AgentPath.parse(input.path);
    let stored = this.#stored[path];
    let publicChanged = false;
    let technicalChanged = false;

    for (const event of input.events) {
      if (event.offset <= (stored?.lastEventOffset ?? 0)) continue;

      // Streams accept arbitrary events. Mirror processor semantics: a known
      // type with a malformed payload remains a raw log entry but does not
      // reach this reducer or wedge the project catalog.
      if (!agentProjectionEventPayloadIsValid(event)) {
        if (stored !== undefined) {
          stored = { ...stored, lastEventOffset: event.offset };
          technicalChanged = true;
        }
        continue;
      }

      if (event.type === AGENT_CREATED_EVENT_TYPE) {
        if (stored === undefined || stored.lastEventOffset === 0) {
          stored = {
            record: createAgentRecord(path, event.createdAt),
            lastEventOffset: event.offset,
            runtimeSinceOffset: 0,
          };
          publicChanged = true;
          technicalChanged = true;
        } else {
          throw new Error(`Agent projection received more than one agent/created event at ${path}`);
        }
        continue;
      }

      if (stored === undefined) {
        throw new Error(
          `Agent projection received ${event.type} at ${path}#${event.offset} before agent/created`,
        );
      }
      const folded = foldAgentProjectionEvent(stored, event);
      stored =
        folded === stored
          ? { ...stored, lastEventOffset: event.offset }
          : { ...folded, lastEventOffset: event.offset };
      technicalChanged = true;
      if (folded.record !== this.#stored[path]?.record) publicChanged = true;
    }

    if (stored === undefined || !technicalChanged) return;
    const previous = this.#stored[path];
    this.#store(path, stored);
    this.#stored = { ...this.#stored, [path]: stored };
    if (publicChanged || previous === undefined || previous.record !== stored.record) {
      this.#projection = { ...this.#projection, [path]: stored.record };
    }
  }

  #store(path: string, stored: StoredAgent): void {
    this.#sql.exec(
      `INSERT OR REPLACE INTO agents
       (path, record, last_event_offset, runtime_since_offset, waiting_for_since_offset)
       VALUES (?, ?, ?, ?, ?)`,
      path,
      JSON.stringify(stored.record),
      stored.lastEventOffset,
      stored.runtimeSinceOffset,
      stored.waitingForSinceOffset ?? null,
    );
  }

  #load(): Record<string, StoredAgent> {
    const stored: Record<string, StoredAgent> = {};
    for (const row of this.#sql.exec(`SELECT * FROM agents`).toArray()) {
      const record = AgentRecord.parse(JSON.parse(row.record as string));
      const path = AgentPath.parse(row.path);
      if (record.path !== path) {
        throw new Error(
          `Agent projection row key ${path} does not match record path ${record.path}`,
        );
      }
      stored[path] = {
        record,
        lastEventOffset: Number(row.last_event_offset),
        runtimeSinceOffset: Number(row.runtime_since_offset),
        ...(row.waiting_for_since_offset === null
          ? {}
          : { waitingForSinceOffset: Number(row.waiting_for_since_offset) }),
      };
    }
    return stored;
  }
}

function agentProjectionEventPayloadIsValid(event: AgentProjectionEvent): boolean {
  switch (event.type) {
    case AGENT_CREATED_EVENT_TYPE:
      return AgentBirthCertificate.safeParse(event.payload).success;
    case AGENT_METADATA_CHANGED_EVENT_TYPE:
      return AgentMetadataPatch.safeParse(event.payload).success;
    case AGENT_WAITING_CLEARED_EVENT_TYPE:
      return AgentWaitingCleared.safeParse(event.payload).success;
    case AGENT_RUNTIME_CHANGED_EVENT_TYPE:
      return AgentRuntimeChange.safeParse(event.payload).success;
    case AGENT_BINDING_SET_EVENT_TYPE:
      return AgentBinding.safeParse(event.payload).success;
    default:
      return false;
  }
}

function createAgentRecord(path: string, createdAt: string): AgentRecordValue {
  return AgentRecord.parse({
    path,
    metadata: AgentMetadata.parse({}),
    runtime: ZERO_AGENT_RUNTIME,
    timestamps: { createdAt, lastWorkAt: createdAt },
  });
}

function foldAgentProjectionEvent(stored: StoredAgent, event: AgentProjectionEvent): StoredAgent {
  switch (event.type) {
    case AGENT_METADATA_CHANGED_EVENT_TYPE: {
      const patch = AgentMetadataPatch.parse(event.payload);
      const metadata = applyAgentMetadataPatch(stored.record.metadata, patch);
      const waitingForSinceOffset =
        patch.waitingFor === undefined
          ? stored.waitingForSinceOffset
          : patch.waitingFor === null
            ? undefined
            : event.offset;
      if (metadata === stored.record.metadata) {
        return waitingForSinceOffset === stored.waitingForSinceOffset
          ? stored
          : { ...stored, waitingForSinceOffset };
      }
      const activityChanged = metadata.activity !== stored.record.metadata.activity;
      return {
        ...stored,
        waitingForSinceOffset,
        record: {
          ...stored.record,
          metadata,
          timestamps: {
            ...stored.record.timestamps,
            metadataUpdatedAt: event.createdAt,
            ...(activityChanged
              ? { activityUpdatedAt: event.createdAt, lastWorkAt: event.createdAt }
              : {}),
          },
        },
      };
    }
    case AGENT_WAITING_CLEARED_EVENT_TYPE: {
      const clear = AgentWaitingCleared.parse(event.payload);
      if (
        stored.record.metadata.waitingFor === undefined ||
        stored.waitingForSinceOffset === undefined ||
        stored.waitingForSinceOffset > clear.throughOffset
      ) {
        return stored;
      }
      return {
        ...stored,
        waitingForSinceOffset: undefined,
        record: {
          ...stored.record,
          metadata: applyAgentMetadataPatch(stored.record.metadata, { waitingFor: null }),
          timestamps: { ...stored.record.timestamps, metadataUpdatedAt: event.createdAt },
        },
      };
    }
    case AGENT_RUNTIME_CHANGED_EVENT_TYPE: {
      const change = AgentRuntimeChange.parse(event.payload);
      const current = {
        sinceOffset: stored.runtimeSinceOffset,
        runtime: stored.record.runtime,
      };
      const merged = mergeAgentRuntimeChange(current, change);
      if (merged === current) return stored;
      if (agentRuntimesEqual(stored.record.runtime, merged.runtime)) {
        return { ...stored, runtimeSinceOffset: merged.sinceOffset };
      }
      return {
        ...stored,
        runtimeSinceOffset: merged.sinceOffset,
        record: {
          ...stored.record,
          runtime: merged.runtime,
          timestamps: {
            ...stored.record.timestamps,
            runtimeUpdatedAt: event.createdAt,
            lastWorkAt: event.createdAt,
          },
        },
      };
    }
    case AGENT_BINDING_SET_EVENT_TYPE: {
      const binding = AgentBinding.parse(event.payload);
      if (JSON.stringify(binding) === JSON.stringify(stored.record.binding)) return stored;
      return { ...stored, record: { ...stored.record, binding } };
    }
    default:
      return stored;
  }
}
