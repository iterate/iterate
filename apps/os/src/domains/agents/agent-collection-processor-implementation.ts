import { StreamProcessor, type ReduceArgs, type StreamEvent } from "iterate/processors";
import { AgentPath, foldAgentSummaryUpdated } from "./agent-presence.ts";
import { AgentCollectionProcessorContract } from "./agent-collection-processor-contract.ts";

/**
 * The project's agent catalog, reduced from cross-posted agent facts.
 *
 * HOW IT WORKS, end to end:
 *
 * Every project has ONE agent collection stream at `/agents`. Each agent
 * stream (`/agents/<name>`) cross-posts its `agent/created` and
 * `agent/summary-updated` events into it — the AgentCollectionDurableObject
 * configures that deliberately narrow push subscription when it births the
 * collection with `agent-collection/created`. `reduce` projects the copies
 * into `state.agents`, keyed by canonical agent path: creation inserts a
 * fresh record (`pinned: false`, source-time timestamps); a summary update
 * merges through the shared summary projection (`foldAgentSummaryUpdated`)
 * and stamps `summaryUpdatedAt` — plus `activityUpdatedAt`/`lastWorkAt` when
 * the activity text actually changed, so "last worked" tracks visible work,
 * not summary chatter.
 *
 * Every timestamp comes from the SOURCE hop
 * (`event.source.crossPostedFrom.at(-1)`), never from the copy's own commit
 * time: a copy can arrive long after the source fact, and the catalog must
 * preserve source chronology, not ingest delay. A copy without that
 * provenance cannot be attributed to an agent, so reduce rejects it loudly
 * rather than guessing.
 *
 * The waitingFor race: an agent clears its own `waitingFor` with a
 * CONDITIONAL clear (`clearWaitingForThroughOffset`, guarded by the source
 * offset that most recently SET a wait) so a delayed clear cannot erase a
 * newer wait. `state.waitingForSinceOffsets` carries that per-agent source
 * offset; it is reducer bookkeeping, invisible to presentation.
 *
 * A pure projector: no `processEvent`, no side effects, no obligations — the
 * reduced state IS the product (`itx.agents.list()`, the sidebar roster, and
 * the DO's `waitUntilAgentCreated` read-after-create barrier all read it).
 */
export class AgentCollectionStreamProcessor extends StreamProcessor<AgentCollectionProcessorContract> {
  readonly contract = AgentCollectionProcessorContract;

  protected override reduce(args: ReduceArgs<AgentCollectionProcessorContract>) {
    const { event, state } = args;
    switch (event.type) {
      case "events.iterate.com/agent-collection/created": {
        if (state.birthCertificate !== null) return state;
        return { ...state, birthCertificate: event.payload };
      }
      case "events.iterate.com/agent/created": {
        const source = crossPostedAgentSource(event);
        if (state.agents[source.path] !== undefined) return state;
        return {
          ...state,
          agents: {
            ...state.agents,
            [source.path]: {
              path: source.path,
              summary: { pinned: false },
              timestamps: { createdAt: source.createdAt, lastWorkAt: source.createdAt },
            },
          },
        };
      }
      case "events.iterate.com/agent/summary-updated": {
        const source = crossPostedAgentSource(event);
        const previous = state.agents[source.path];
        if (previous === undefined) {
          throw new Error(
            `agent collection received ${event.type} for ${source.path} before agent/created`,
          );
        }
        const projection = foldAgentSummaryUpdated({
          summary: previous.summary,
          waitingForSinceOffset: state.waitingForSinceOffsets[source.path],
          update: event.payload,
          atOffset: source.offset,
        });
        if (projection === undefined) return state;
        const { summary, waitingForSinceOffset } = projection;
        const activityChanged = summary.activity !== previous.summary.activity;
        const waitingForSinceOffsets = { ...state.waitingForSinceOffsets };
        if (waitingForSinceOffset === undefined) delete waitingForSinceOffsets[source.path];
        else waitingForSinceOffsets[source.path] = waitingForSinceOffset;
        return {
          ...state,
          waitingForSinceOffsets,
          agents: {
            ...state.agents,
            [source.path]: {
              ...previous,
              summary,
              timestamps: {
                ...previous.timestamps,
                summaryUpdatedAt: source.createdAt,
                ...(activityChanged
                  ? { activityUpdatedAt: source.createdAt, lastWorkAt: source.createdAt }
                  : {}),
              },
            },
          },
        };
      }
      default:
        return state;
    }
  }
}

/**
 * The last cross-post hop of a copied agent fact: which agent stream it came
 * from (parsed to a canonical path) and the fact's ORIGINAL coordinates —
 * its offset and commit time on the SOURCE stream. Reduced catalog
 * timestamps and the waitingFor race guard read these, never the copy's own
 * commit time. Throws when the hop is missing: an unattributable agent fact
 * must fail the frame, not corrupt the catalog.
 */
function crossPostedAgentSource(event: Pick<StreamEvent, "type" | "source">): {
  path: AgentPath;
  createdAt: string;
  offset: number;
} {
  const source = event.source?.crossPostedFrom?.at(-1);
  if (source === undefined) {
    throw new Error(`agent collection received ${event.type} without cross-post provenance`);
  }
  return {
    path: AgentPath.parse(source.path),
    createdAt: source.createdAt,
    offset: source.offset,
  };
}
