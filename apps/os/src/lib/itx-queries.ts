// Shared itx-backed query definitions. Co-locating key + queryFn keeps every
// consumer of the same data on the same TanStack cache entry, so one
// invalidation reaches all of them.

import type { StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import { itxKey, useItxQuery } from "~/itx/react/index.ts";
import { PROJECT_CHILD_ROUTE_STALE_TIME } from "~/lib/project-route-query.ts";
import { StreamNavigationState } from "~/lib/stream-navigation-state.ts";

export function projectStreamStateKey(projectId: string, streamPath: StreamPathType) {
  return itxKey.project(projectId, "streams", "state", streamPath);
}

export function useProjectStreamState(input: { projectId: string; streamPath: StreamPathType }) {
  return useItxQuery({
    project: input.projectId,
    queryKey: projectStreamStateKey(input.projectId, input.streamPath),
    queryFn: async (itx) =>
      StreamNavigationState.parse(await itx.streams.get(input.streamPath).getState()),
    staleTime: PROJECT_CHILD_ROUTE_STALE_TIME,
  });
}
