import { takeText } from "@iterate-com/shared/chunked-text";
import { createJsonByteLength } from "@iterate-com/shared/json-byte-length";
import { z } from "zod";
import {
  StreamProcessor,
  type EmittedInput,
  type ProcessEventArgs,
  type ReduceArgs,
  type StreamEvent,
} from "iterate/processors";
import {
  AgentUiActivitySchema,
  initialAgentUiState,
  reduceAgentUi,
  reduceAgentUiRuntime,
  type AgentUiItem,
  type AgentUiState,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import { AgentRuntimeTransition } from "../agents/agent-processor-contract.ts";
import { FeedItemPublication, FeedProcessorContract, type FeedLiveState } from "./feed-contract.ts";

type FeedState = ReturnType<typeof FeedProcessorContract.stateSchema.parse>;

/** Pure publication input: ephemeral text never changes a durable item revision. */
export function reduceFeed(
  state: FeedState,
  event: StreamEvent,
): { state: FeedState; items: AgentUiItem[] } {
  if (event.ephemeral || event.type === "events.iterate.com/feed/item-published") {
    return { state, items: [] };
  }
  if (event.type === "events.iterate.com/agent/runtime-changed") {
    const runtimeChange = AgentRuntimeTransition.parse(event.payload);
    if (
      runtimeChange.sinceOffset < state.activityStartOffset ||
      runtimeChange.sinceOffset <= (state.runtimeChange?.sinceOffset ?? -1)
    ) {
      return { state, items: [] };
    }
    const reduced = reduceAgentUiRuntime(state.agent, runtimeChange);
    return { state: { ...state, agent: reduced.endState, runtimeChange }, items: reduced.items };
  }
  const reduced = reduceAgentUi(state.agent, { ...event, streamPath: event.path });
  return {
    state: {
      ...state,
      agent: reduced.endState,
      activityStartOffset:
        event.type === "events.iterate.com/agent/llm-request-requested" ||
        event.type === "events.iterate.com/capability-host/script-run-requested"
          ? event.offset
          : state.activityStartOffset,
    },
    items: reduced.items,
  };
}

/** Durable index of publications, used only for stable positions and late corrections. */
type FeedPublicationStore = {
  clear(): void;
  latestOffset(): number;
  get(itemId: string): FeedItemPublication | undefined;
  findInferredActivity(executionId: string): FeedItemPublication | undefined;
  save(publication: FeedItemPublication, offset: number): void;
};

// Cloudflare Durable Object SQLite accepts neither a text nor BLOB cell above
// roughly 2 MiB. Feed rows preserve full renderable revisions, so store their
// JSON bytes in bounded rows just as the stream event log does.
const FEED_PUBLICATION_CHUNK_BYTES = 512 * 1024;
const FEED_PUBLICATION_CHUNKED = "feed-publication-chunked-v1";
const feedPublicationEncoder = new TextEncoder();
const feedPublicationDecoder = new TextDecoder();

function* chunkFeedPublication(value: Uint8Array): Generator<[number, ArrayBuffer]> {
  let index = 0;
  for (let start = 0; start < value.byteLength; start += FEED_PUBLICATION_CHUNK_BYTES) {
    const chunk = value.slice(
      start,
      Math.min(start + FEED_PUBLICATION_CHUNK_BYTES, value.byteLength),
    );
    yield [index, chunk.buffer];
    index += 1;
  }
  if (index === 0) yield [0, new ArrayBuffer(0)];
}

function decodeFeedPublication(chunks: ArrayBuffer[]): FeedItemPublication {
  let value = "";
  for (const chunk of chunks) value += feedPublicationDecoder.decode(chunk, { stream: true });
  return FeedItemPublication.parse(JSON.parse(value + feedPublicationDecoder.decode()));
}

function inferredExecutionIds(publication: FeedItemPublication): string[] {
  if (publication.item.kind !== "activity") return [];
  return publication.item.steps.flatMap((step) =>
    step.kind === "code" && step.outcomeSource === "inferred" ? [step.executionId] : [],
  );
}

const ScriptSettlement = z.object({ executionId: z.string() });

/** Bound retained LLM preview text across the activity, prioritizing the newest request.
 * Immutable text blocks make a 1 MiB preview cheap to patch and render.
 * This projection never runs on the durable reducer or its published item revisions. */
function boundLlmPreview(agent: AgentUiState): AgentUiState {
  if (!agent.live) return agent;
  let remaining = 1024 * 1024;
  const steps = agent.live.steps.toReversed().map((step) => {
    if (step.kind !== "llm") return step;
    const responseText = takeText(step.responseText, remaining);
    remaining -= responseText.length;
    const thinkingText = takeText(step.thinkingText, remaining);
    remaining -= thinkingText.length;
    if (responseText === step.responseText && thinkingText === step.thinkingText) return step;
    return { ...step, responseText, thinkingText, previewTruncated: true };
  });
  return { ...agent, live: { ...agent.live, steps: steps.toReversed() } };
}

export class FeedProcessor extends StreamProcessor<
  FeedProcessorContract,
  {
    publications: FeedPublicationStore;
    refreshLive: () => void;
  }
> {
  readonly contract = FeedProcessorContract;
  #volatileAgent: AgentUiState | undefined;
  #volatileThroughOffset = 0;
  readonly #jsonByteLength = createJsonByteLength();

  resetForStream(): void {
    this.deps.publications.clear();
    this.#volatileAgent = undefined;
    this.#volatileThroughOffset = 0;
  }

  presentation(state: FeedState, streamId: string | null): FeedLiveState {
    const agent = this.#volatileAgent ?? boundLlmPreview(state.agent);
    const snapshot = {
      previewStatus: agent.live?.steps.some((step) => step.kind === "llm" && step.previewTruncated)
        ? "shortened"
        : "available",
      streamId,
      publicationOffset: this.deps.publications.latestOffset(),
      agent: {
        live: agent.live,
        queuedUserMessages: agent.queuedUserMessages,
        presence: agent.presence,
        tokenUsage: agent.tokenUsage,
      },
      runtimeChange: state.runtimeChange,
    } satisfies FeedLiveState;
    // Code, results, queued messages and presence are also unbounded inputs.
    // Omit an oversized preview explicitly, keeping the source/cursor/runtime
    // usable and leaving complete data in the durable events and publications.
    if (this.#jsonByteLength(snapshot) > 8 * 1024 * 1024) {
      return {
        previewStatus: "omitted",
        streamId,
        publicationOffset: snapshot.publicationOffset,
        runtimeChange: snapshot.runtimeChange,
        agent: null,
      };
    }
    return snapshot;
  }

  protected override reduce({ state, event }: ReduceArgs<FeedProcessorContract>) {
    return reduceFeed(state, event).state;
  }

  protected override processEvent(args: ProcessEventArgs<FeedProcessorContract>): undefined {
    // Wildcard consumption includes domain events beyond the named ephemeral types.
    const event: StreamEvent | null = args.event;
    if (!event || event.type === "events.iterate.com/feed/item-published") return;
    if (event.ephemeral) {
      if (event.offset <= this.#volatileThroughOffset) return;
      this.#volatileThroughOffset = event.offset;
      this.#volatileAgent = boundLlmPreview(
        reduceAgentUi(this.#volatileAgent ?? args.previousState.agent, {
          ...event,
          streamPath: event.path,
        }).endState,
      );
      this.deps.refreshLive();
      return;
    }
    const advanceVolatile = () => {
      if (this.#volatileAgent && event.offset > this.#volatileThroughOffset) {
        this.#volatileThroughOffset = event.offset;
        this.#volatileAgent = boundLlmPreview(
          reduceFeed({ ...args.previousState, agent: this.#volatileAgent }, event).state.agent,
        );
      }
    };
    const { items } = reduceFeed(args.previousState, event);
    if (event.type === "events.iterate.com/capability-host/script-run-settled") {
      const { executionId } = ScriptSettlement.parse(event.payload);
      const prior = this.deps.publications.findInferredActivity(executionId);
      if (
        prior &&
        prior.revisionOffset < event.offset &&
        !items.some((item) => item.id === prior.item.id)
      ) {
        const activity = AgentUiActivitySchema.parse(prior.item);
        const corrected = reduceAgentUi(
          { ...initialAgentUiState(), provisionalActivities: { [activity.id]: activity } },
          { ...event, streamPath: event.path },
        );
        items.push(...corrected.items);
      }
    }
    if (items.length === 0) {
      advanceVolatile();
      return;
    }
    // Losing this consequence would permanently omit an item from browser feeds.
    // Block cursor advancement until its idempotent publication is committed.
    args.blockProcessorWhile(async () => {
      const publications = items.map((item, ordinal) => {
        const previous = this.deps.publications.get(item.id);
        return {
          item,
          firstOffset: previous?.firstOffset ?? event.offset,
          ordinal: previous?.ordinal ?? ordinal,
          revisionOffset: event.offset,
        };
      });
      const committed = await args.append(
        ...publications.map<EmittedInput<FeedProcessorContract>>((publication) => ({
          type: "events.iterate.com/feed/item-published",
          payload: publication,
          idempotencyKey: this.idempotencyKey(`v1/${publication.item.id}`, event),
        })),
      );
      for (let index = 0; index < publications.length; index++) {
        this.deps.publications.save(publications[index]!, committed[index]!.offset);
      }
      // Do not expose the settled volatile state until its publication offset exists.
      advanceVolatile();
      this.deps.refreshLive();
    });
  }
}

export function createFeedPublicationStore(
  sql: SqlStorage,
  transactionSync: <T>(closure: () => T) => T,
): FeedPublicationStore {
  sql.exec(`CREATE TABLE IF NOT EXISTS feed_publications (
    item_id TEXT PRIMARY KEY, revision_offset INTEGER NOT NULL,
    publication_offset INTEGER NOT NULL, data TEXT NOT NULL
  )`);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS feed_publications_recent ON feed_publications(publication_offset)`,
  );
  sql.exec(`CREATE TABLE IF NOT EXISTS feed_publication_chunks (
    item_id TEXT NOT NULL, revision_offset INTEGER NOT NULL, chunk_index INTEGER NOT NULL,
    chunk_bytes BLOB NOT NULL,
    PRIMARY KEY (item_id, revision_offset, chunk_index)
  ) WITHOUT ROWID`);
  sql.exec(`CREATE TABLE IF NOT EXISTS feed_publication_inferred_steps (
    execution_id TEXT NOT NULL, item_id TEXT NOT NULL, revision_offset INTEGER NOT NULL,
    PRIMARY KEY (execution_id, item_id)
  ) WITHOUT ROWID`);

  const readChunks = (itemId: string, revisionOffset: number) =>
    sql
      .exec<{ chunk_bytes: ArrayBuffer }>(
        `SELECT chunk_bytes FROM feed_publication_chunks
         WHERE item_id = ? AND revision_offset = ? ORDER BY chunk_index ASC`,
        itemId,
        revisionOffset,
      )
      .toArray()
      .map((row) => row.chunk_bytes);
  const read = (row: { item_id: string; revision_offset: number; data: string }) =>
    row.data === FEED_PUBLICATION_CHUNKED
      ? decodeFeedPublication(readChunks(row.item_id, row.revision_offset))
      : FeedItemPublication.parse(JSON.parse(row.data));

  // Existing rows are necessarily below SQLite's single-cell limit. Upgrade
  // once, keeping the legacy JSON authoritative until all chunks were written.
  const legacy = sql
    .exec<{ item_id: string; revision_offset: number; data: string }>(
      `SELECT item_id, revision_offset, data FROM feed_publications WHERE data != ?`,
      FEED_PUBLICATION_CHUNKED,
    )
    .toArray();
  for (const row of legacy) {
    transactionSync(() => {
      const publication = FeedItemPublication.parse(JSON.parse(row.data));
      sql.exec(
        `DELETE FROM feed_publication_chunks WHERE item_id = ? AND revision_offset = ?`,
        row.item_id,
        row.revision_offset,
      );
      for (const [index, chunk] of chunkFeedPublication(feedPublicationEncoder.encode(row.data))) {
        sql.exec(
          `INSERT INTO feed_publication_chunks(item_id, revision_offset, chunk_index, chunk_bytes)
           VALUES (?, ?, ?, ?)`,
          row.item_id,
          row.revision_offset,
          index,
          chunk,
        );
      }
      for (const executionId of inferredExecutionIds(publication)) {
        sql.exec(
          `INSERT INTO feed_publication_inferred_steps(execution_id, item_id, revision_offset)
           VALUES (?, ?, ?) ON CONFLICT(execution_id, item_id) DO UPDATE SET
           revision_offset = excluded.revision_offset`,
          executionId,
          row.item_id,
          row.revision_offset,
        );
      }
      sql.exec(
        `UPDATE feed_publications SET data = ? WHERE item_id = ? AND revision_offset = ?`,
        FEED_PUBLICATION_CHUNKED,
        row.item_id,
        row.revision_offset,
      );
    });
  }

  return {
    latestOffset() {
      return (
        sql
          .exec<{ offset: number }>(
            `SELECT COALESCE(MAX(publication_offset), 0) AS offset FROM feed_publications`,
          )
          .toArray()[0]?.offset ?? 0
      );
    },
    clear() {
      transactionSync(() => {
        sql.exec(`DELETE FROM feed_publication_inferred_steps`);
        sql.exec(`DELETE FROM feed_publication_chunks`);
        sql.exec(`DELETE FROM feed_publications`);
      });
    },
    get(itemId) {
      const row = sql
        .exec<{ item_id: string; revision_offset: number; data: string }>(
          `SELECT item_id, revision_offset, data FROM feed_publications WHERE item_id = ?`,
          itemId,
        )
        .toArray()[0];
      return row ? read(row) : undefined;
    },
    findInferredActivity(executionId) {
      const row = sql
        .exec<{ item_id: string; revision_offset: number; data: string }>(
          `SELECT p.item_id, p.revision_offset, p.data
           FROM feed_publication_inferred_steps i
           JOIN feed_publications p ON p.item_id = i.item_id AND p.revision_offset = i.revision_offset
           WHERE i.execution_id = ? ORDER BY p.publication_offset DESC LIMIT 1`,
          executionId,
        )
        .toArray()[0];
      return row ? read(row) : undefined;
    },
    save(publication, offset) {
      transactionSync(() => {
        const existing = sql
          .exec<{ revision_offset: number }>(
            `SELECT revision_offset FROM feed_publications WHERE item_id = ?`,
            publication.item.id,
          )
          .toArray()[0];
        if (existing && existing.revision_offset > publication.revisionOffset) return;
        const raw = JSON.stringify(publication);
        sql.exec(`DELETE FROM feed_publication_chunks WHERE item_id = ?`, publication.item.id);
        for (const [index, chunk] of chunkFeedPublication(feedPublicationEncoder.encode(raw))) {
          sql.exec(
            `INSERT INTO feed_publication_chunks(item_id, revision_offset, chunk_index, chunk_bytes)
             VALUES (?, ?, ?, ?)`,
            publication.item.id,
            publication.revisionOffset,
            index,
            chunk,
          );
        }
        sql.exec(
          `INSERT INTO feed_publications(item_id, revision_offset, publication_offset, data)
           VALUES (?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET
             revision_offset = excluded.revision_offset, publication_offset = excluded.publication_offset,
             data = excluded.data WHERE excluded.revision_offset >= revision_offset`,
          publication.item.id,
          publication.revisionOffset,
          offset,
          FEED_PUBLICATION_CHUNKED,
        );
        sql.exec(
          `DELETE FROM feed_publication_inferred_steps WHERE item_id = ?`,
          publication.item.id,
        );
        for (const executionId of inferredExecutionIds(publication)) {
          sql.exec(
            `INSERT INTO feed_publication_inferred_steps(execution_id, item_id, revision_offset)
             VALUES (?, ?, ?) ON CONFLICT(execution_id, item_id) DO UPDATE SET
             revision_offset = excluded.revision_offset`,
            executionId,
            publication.item.id,
            publication.revisionOffset,
          );
        }
      });
    },
  };
}
