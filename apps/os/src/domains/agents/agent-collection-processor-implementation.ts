import { StreamProcessor } from "iterate/processors";
import { AgentPath, applyAgentSummaryUpdate } from "./agent-presence.ts";
import {
  AGENT_COLLECTION_CREATED_EVENT_TYPE,
  AgentCollectionProcessorContract,
} from "./agent-collection-processor-contract.ts";

export class AgentCollectionStreamProcessor extends StreamProcessor<AgentCollectionProcessorContract> {
  readonly contract = AgentCollectionProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<AgentCollectionProcessorContract>["reduce"]>[0]) {
    if (event.type === AGENT_COLLECTION_CREATED_EVENT_TYPE) {
      if (state.birthCertificate !== null) {
        throw new Error("agent collection received more than one created event");
      }
      return { ...state, birthCertificate: event.payload };
    }

    const source = event.source?.crossPostedFrom?.at(-1);
    if (source === undefined) {
      throw new Error(`agent collection received ${event.type} without cross-post provenance`);
    }
    const path = AgentPath.parse(source.path);

    if (event.type === "events.iterate.com/agent/created") {
      if (state.agents[path] !== undefined) {
        throw new Error(`agent collection received more than one agent/created event for ${path}`);
      }
      return {
        ...state,
        agents: {
          ...state.agents,
          [path]: {
            path,
            summary: { pinned: false },
            timestamps: { createdAt: source.createdAt, lastWorkAt: source.createdAt },
          },
        },
      };
    }

    const previous = state.agents[path];
    if (previous === undefined) {
      throw new Error(`agent collection received ${event.type} for ${path} before agent/created`);
    }
    const waitingForSinceOffset = state.waitingForSinceOffsets[path];
    if (
      "clearWaitingForThroughOffset" in event.payload &&
      (previous.summary.waitingFor === undefined ||
        waitingForSinceOffset === undefined ||
        waitingForSinceOffset > event.payload.clearWaitingForThroughOffset)
    ) {
      return state;
    }
    const summary = applyAgentSummaryUpdate(previous.summary, event.payload);
    const nextWaitingForSinceOffset =
      event.payload.waitingFor === undefined
        ? waitingForSinceOffset
        : event.payload.waitingFor === null
          ? undefined
          : source.offset;
    if (summary === previous.summary && nextWaitingForSinceOffset === waitingForSinceOffset) {
      return state;
    }
    const activityChanged = summary.activity !== previous.summary.activity;
    const waitingForSinceOffsets = { ...state.waitingForSinceOffsets };
    if (nextWaitingForSinceOffset === undefined) delete waitingForSinceOffsets[path];
    else waitingForSinceOffsets[path] = nextWaitingForSinceOffset;
    return {
      ...state,
      waitingForSinceOffsets,
      agents: {
        ...state.agents,
        [path]: {
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
}
