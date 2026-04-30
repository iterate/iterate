import { StreamPath } from "@iterate-com/events-contract";
import { z } from "zod";

const AgentViewSearch = z.object({
  streamPath: z.string().optional(),
});

export type AgentViewSearch = {
  streamPath: StreamPath | undefined;
};

export const defaultAgentViewSearch: AgentViewSearch = {
  streamPath: undefined,
};

export function validateAgentViewSearch(search: unknown): AgentViewSearch {
  // Route search is the source of truth for the selected sidebar agent, so a
  // copied URL opens the same in-app stream view after refresh.
  const result = AgentViewSearch.safeParse(search);
  if (!result.success || result.data.streamPath == null) {
    return defaultAgentViewSearch;
  }

  const streamPath = StreamPath.safeParse(result.data.streamPath);
  if (!streamPath.success) {
    return defaultAgentViewSearch;
  }

  return {
    streamPath: streamPath.data,
  };
}
