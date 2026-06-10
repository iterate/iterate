// Shared itx-backed query definitions. Each piece of data has exactly ONE
// {key, queryFn, staleTime} definition (an ItxQueryDefinition), consumed by
// the React hook AND by route-loader prefetches (prefetchItxQuery) — so a
// loader can never seed a different cache entry than the component reads,
// and one invalidation reaches every consumer.

import { StreamState, type StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import { itxKey, useItxQuery } from "~/itx/react/index.ts";
import type { ItxQueryDefinition } from "~/itx/loader.ts";
import { PROJECT_CHILD_ROUTE_STALE_TIME } from "~/lib/project-route-query.ts";

export function projectStreamStateKey(projectId: string, streamPath: StreamPathType) {
  return itxKey.project(projectId, "streams", "state", streamPath);
}

/**
 * One stream's reduced state. Shared by the streams index tree (which seeds
 * the root path from its route loader), the breadcrumb navigators, and any
 * future view of the same stream — all on the same cache entry per path.
 */
export function projectStreamStateQuery(input: {
  projectId: string;
  streamPath: StreamPathType;
}): ItxQueryDefinition<StreamState> {
  return {
    project: input.projectId,
    queryKey: projectStreamStateKey(input.projectId, input.streamPath),
    queryFn: async (itx) => StreamState.parse(await itx.streams.get(input.streamPath).getState()),
    staleTime: PROJECT_CHILD_ROUTE_STALE_TIME,
  };
}

export function useProjectStreamState(input: { projectId: string; streamPath: StreamPathType }) {
  return useItxQuery(projectStreamStateQuery(input));
}
