import type { AgentUiItem } from "@iterate-com/ui/components/events/agent-ui-reducer";
import type { ProcessorProgress, ProcessorProgressStore } from "iterate/processors";
import { processorProgressKey } from "iterate/processors/cloudflare";
import { StreamFeedContract } from "./contract.ts";
import type { RawFeedItemData, StreamFeedState } from "./projector.ts";
import { STREAM_FEED_SCHEMA_VERSION, initialStreamFeedState } from "./projector.ts";
import { ProjectionWriteBuffer } from "./projection-write-buffer.ts";
import { STREAM_FEED_SCHEMA_STATEMENTS } from "./processor.ts";
import type { StreamFeedSqlClient, StreamFeedSqlValue } from "./sql.ts";
import { buildStreamFeedWhere } from "./filter.ts";
import { validateStreamFeedReadInput } from "./read-input.ts";
import type { StreamFeedItem, StreamFeedPage, StreamFeedReadInput } from "./types.ts";

const STORAGE_VERSION_KEY = "stream-feed:storage-version";
const CATCH_UP_SCHEDULED_KEY = "stream-feed:catch-up-scheduled";
const STORAGE_VERSION = `${StreamFeedContract.version}:${STREAM_FEED_SCHEMA_VERSION}`;
const DEFAULT_PAGE_LIMIT = 100;

/** Stream-feed SQLite plus the cursor store that commits projection and progress atomically. */
export class StreamFeedStorage {
  readonly sqlClient: StreamFeedSqlClient;
  readonly progress: ProcessorProgressStore<StreamFeedState>;
  readonly #progressKey = processorProgressKey(StreamFeedContract.slug);

  constructor(
    readonly storage: DurableObjectStorage,
    readonly sql: SqlStorage,
    readonly projection = new ProjectionWriteBuffer(),
  ) {
    this.sqlClient = {
      exec: async (statement, params = []) =>
        this.sql
          .exec(
            statement,
            ...(params as Parameters<SqlStorage["exec"]> extends [string, ...infer P] ? P : never),
          )
          .toArray() as Record<string, StreamFeedSqlValue>[],
      batch: async (statements, options) => {
        const run = () => {
          for (const statement of statements) {
            this.sql.exec(statement.sql, ...(statement.params ?? []));
          }
        };
        if (options?.transaction === true) this.storage.transactionSync(run);
        else run();
      },
    };

    this.progress = {
      read: () => this.#readProgress(),
      commit: (progress, options) => this.#commit(progress, options.expectedCursorRevision),
    };
  }

  #ensureSchema(): void {
    for (const statement of STREAM_FEED_SCHEMA_STATEMENTS) {
      this.sql.exec(statement.sql, ...(statement.params ?? []));
    }
  }

  /** Whether an earlier bounded turn durably requested another alarm slice. */
  catchUpScheduled(): boolean {
    return this.storage.kv.get<boolean>(CATCH_UP_SCHEDULED_KEY) === true;
  }

  /** Persist the feed alarm desire independently of the Stream DO's other alarm users. */
  setCatchUpScheduled(scheduled: boolean): void {
    if (scheduled) this.storage.kv.put(CATCH_UP_SCHEDULED_KEY, true);
    else this.storage.kv.delete(CATCH_UP_SCHEDULED_KEY);
  }

  #readProgress(): ProcessorProgress<StreamFeedState> {
    this.#ensureSchema();
    const persisted = this.storage.kv.get<ProcessorProgress<StreamFeedState>>(this.#progressKey);
    if (this.storage.kv.get<string>(STORAGE_VERSION_KEY) === STORAGE_VERSION) {
      this.projection.hydrate(persisted?.processing.acknowledgedThroughOffset ?? 0);
      return (
        persisted ?? {
          reduction: {
            reducerVersion: StreamFeedContract.version,
            reducedThroughOffset: 0,
            state: initialStreamFeedState(),
          },
          processing: { acknowledgedThroughOffset: 0, cursorRevision: 0 },
        }
      );
    }

    // A projection algorithm/schema deploy invalidates BOTH the rows and the
    // processing acknowledgement. Rewind with a revision bump in the same
    // synchronous storage transaction so an old continuation can never stamp
    // its stale cursor over the rebuilding table.
    const reset: ProcessorProgress<StreamFeedState> = {
      reduction: {
        reducerVersion: StreamFeedContract.version,
        reducedThroughOffset: 0,
        state: initialStreamFeedState(),
      },
      processing: {
        acknowledgedThroughOffset: 0,
        cursorRevision: (persisted?.processing.cursorRevision ?? 0) + 1,
      },
    };
    this.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM feed_items`);
      this.storage.kv.put(this.#progressKey, reset);
      this.storage.kv.put(STORAGE_VERSION_KEY, STORAGE_VERSION);
      this.storage.kv.delete(CATCH_UP_SCHEDULED_KEY);
    });
    this.projection.hydrate(0);
    return reset;
  }

  #commit(progress: ProcessorProgress<StreamFeedState>, expectedCursorRevision: number): void {
    this.#ensureSchema();
    const projectionStatements = this.projection.drainThrough(
      progress.processing.acknowledgedThroughOffset,
    );
    this.storage.transactionSync(() => {
      if (this.storage.kv.get<string>(STORAGE_VERSION_KEY) !== STORAGE_VERSION) {
        throw new Error("stream-feed storage version changed during a projection commit");
      }
      const persisted = this.storage.kv.get<ProcessorProgress<StreamFeedState>>(this.#progressKey);
      const revision = persisted?.processing.cursorRevision ?? 0;
      if (revision !== expectedCursorRevision) {
        throw new Error(
          `stream processor "${StreamFeedContract.slug}" progress commit fenced: expected ` +
            `cursorRevision ${expectedCursorRevision}, persisted ${revision}`,
        );
      }
      if (
        persisted !== undefined &&
        progress.processing.acknowledgedThroughOffset <
          persisted.processing.acknowledgedThroughOffset &&
        progress.processing.cursorRevision <= revision
      ) {
        throw new Error(
          `stream processor "${StreamFeedContract.slug}" progress commit fenced: ` +
            "acknowledgement would move backward without a cursor revision bump",
        );
      }
      for (const statement of projectionStatements) {
        this.sql.exec(statement.sql, ...(statement.params ?? []));
      }
      this.storage.kv.put(this.#progressKey, progress);
    });
  }

  read(input: StreamFeedReadInput = {}): Omit<StreamFeedPage, "projection"> {
    this.#ensureSchema();
    const validated = validateStreamFeedReadInput(input);
    const { beforeLocalIndex, filter, offset } = validated;
    const limit = validated.limit ?? DEFAULT_PAGE_LIMIT;
    const where = buildStreamFeedWhere(filter);
    const count = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM feed_items WHERE ${where.whereSql}`,
        ...where.params,
      )
      .one().count;

    const columns = "local_index, kind, first_offset, last_offset, event_count, json(data) AS data";
    const rows =
      offset !== undefined
        ? (this.sql
            .exec(
              `SELECT ${columns} FROM feed_items WHERE ${where.whereSql} ` +
                `ORDER BY local_index ASC LIMIT ? OFFSET ?`,
              ...where.params,
              limit,
              offset,
            )
            .toArray() as Record<string, StreamFeedSqlValue>[])
        : (this.sql
            .exec(
              `SELECT ${columns} FROM (` +
                `SELECT ${columns} FROM feed_items WHERE ${where.whereSql} AND local_index < ? ` +
                `ORDER BY local_index DESC LIMIT ?` +
                `) ORDER BY local_index ASC`,
              ...where.params,
              beforeLocalIndex ?? Number.MAX_SAFE_INTEGER,
              limit,
            )
            .toArray() as Record<string, StreamFeedSqlValue>[]);

    return { items: rows.map(parseItem), total: Number(count) };
  }
}

function parseItem(row: Record<string, StreamFeedSqlValue>): StreamFeedItem {
  const raw = row.data;
  if (typeof raw !== "string") throw new Error("stream-feed row data is not JSON text");
  const data = JSON.parse(raw) as AgentUiItem | RawFeedItemData;
  return {
    localIndex: Number(row.local_index),
    kind: String(row.kind),
    firstOffset: Number(row.first_offset),
    lastOffset: Number(row.last_offset),
    eventCount: Number(row.event_count),
    data,
  };
}
