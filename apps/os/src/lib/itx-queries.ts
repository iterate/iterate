// Shared itx-backed query definitions. Co-locating key + queryFn keeps every
// consumer of the same data on the same TanStack cache entry, so one
// invalidation reaches all of them.

import { StreamState, type StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import { itxKey, useItxQuery } from "~/itx/react/index.ts";
import { PROJECT_CHILD_ROUTE_STALE_TIME } from "~/lib/project-route-query.ts";

export function projectStreamsListKey(projectId: string) {
  return itxKey.project(projectId, "streams", "list");
}

export function projectStreamStateKey(projectId: string, streamPath: StreamPathType) {
  return itxKey.project(projectId, "streams", "state", streamPath);
}

/** The project's stream list — shared by the streams index and breadcrumbs. */
export function useProjectStreamsList(projectId: string) {
  return useItxQuery({
    project: projectId,
    queryKey: projectStreamsListKey(projectId),
    queryFn: (itx) => itx.streams.list(),
    staleTime: PROJECT_CHILD_ROUTE_STALE_TIME,
  });
}

export function useProjectStreamState(input: { projectId: string; streamPath: StreamPathType }) {
  return useItxQuery({
    project: input.projectId,
    queryKey: projectStreamStateKey(input.projectId, input.streamPath),
    queryFn: async (itx) => StreamState.parse(await itx.streams.get(input.streamPath).getState()),
    staleTime: PROJECT_CHILD_ROUTE_STALE_TIME,
  });
}
