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
import { FeedItemPublication } from "@iterate-com/ui/components/events/feed-publication";
import { AgentRuntimeTransition } from "../agents/agent-processor-contract.ts";
import { FeedProcessorContract, type FeedLiveState } from "./feed-contract.ts";

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

export function createFeedPublicationStore(sql: SqlStorage): FeedPublicationStore {
  sql.exec(`CREATE TABLE IF NOT EXISTS feed_publications (
    item_id TEXT PRIMARY KEY, revision_offset INTEGER NOT NULL,
    publication_offset INTEGER NOT NULL, data TEXT NOT NULL
  )`);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS feed_publications_recent ON feed_publications(publication_offset)`,
  );
  return {
    latestOffset() {
      return sql
        .exec<{ offset: number }>(
          `SELECT COALESCE(MAX(publication_offset), 0) AS offset FROM feed_publications`,
        )
        .toArray()[0]!.offset;
    },
    clear() {
      sql.exec(`DELETE FROM feed_publications`);
    },
    get(itemId) {
      const row = sql
        .exec<{ data: string }>(`SELECT data FROM feed_publications WHERE item_id = ?`, itemId)
        .toArray()[0];
      return row ? FeedItemPublication.parse(JSON.parse(row.data)) : undefined;
    },
    findInferredActivity(executionId) {
      const row = sql
        .exec<{ data: string }>(
          `SELECT data FROM feed_publications WHERE EXISTS (
          SELECT 1 FROM json_each(data, '$.item.steps') AS step
          WHERE json_extract(step.value, '$.executionId') = ?
            AND json_extract(step.value, '$.outcomeSource') = 'inferred'
        ) ORDER BY publication_offset DESC LIMIT 1`,
          executionId,
        )
        .toArray()[0];
      return row ? FeedItemPublication.parse(JSON.parse(row.data)) : undefined;
    },
    save(publication, offset) {
      sql.exec(
        `INSERT INTO feed_publications(item_id, revision_offset, publication_offset, data)
        VALUES (?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET
          revision_offset = excluded.revision_offset, publication_offset = excluded.publication_offset,
          data = excluded.data WHERE excluded.revision_offset >= revision_offset`,
        publication.item.id,
        publication.revisionOffset,
        offset,
        JSON.stringify(publication),
      );
    },
  };
}
