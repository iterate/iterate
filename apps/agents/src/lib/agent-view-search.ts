import { StreamPath } from "@iterate-com/shared/streams/types";
import type { EventsStreamElementType } from "@iterate-com/ui/components/events/stream-feed";
import { z } from "zod";

const AgentViewSearch = z.object({
  streamPath: z.string().optional(),
  hiddenElements: z.union([z.string(), z.array(z.string())]).optional(),
});

type AgentViewSearch = {
  streamPath: StreamPath | undefined;
  hiddenElements: EventsStreamElementType[];
};

const defaultAgentViewSearch: AgentViewSearch = {
  streamPath: undefined,
  hiddenElements: [],
};

export function validateAgentViewSearch(search: unknown): AgentViewSearch {
  // Route search is the source of truth for the selected sidebar agent, so a
  // copied URL opens the same in-app stream view after refresh.
  const result = AgentViewSearch.safeParse(search);
  if (!result.success || result.data.streamPath == null) {
    return {
      ...defaultAgentViewSearch,
      hiddenElements: result.success
        ? parseHiddenElementsParam(result.data.hiddenElements)
        : defaultAgentViewSearch.hiddenElements,
    };
  }

  const streamPath = StreamPath.safeParse(result.data.streamPath);
  if (!streamPath.success) {
    return defaultAgentViewSearch;
  }

  return {
    streamPath: streamPath.data,
    hiddenElements: parseHiddenElementsParam(result.data.hiddenElements),
  };
}

function parseHiddenElementsParam(
  value: string | readonly string[] | undefined,
): EventsStreamElementType[] {
  if (value == null) {
    return [];
  }

  const values = typeof value === "string" ? value.split(",") : value;

  return [
    ...new Set(values.map((type) => type.trim()).filter(Boolean)),
  ] as EventsStreamElementType[];
}
