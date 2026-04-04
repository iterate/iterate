import {
  StreamState as PublicStreamStateSchema,
  type StreamState as PublicStreamState,
} from "@iterate-com/events-contract";
import { z } from "zod";
import {
  readScheduleProjectionStateFromTable,
  ScheduleProjectionState,
} from "~/durable-objects/processors/scheduling/types.ts";

export const ReducedStreamState = PublicStreamStateSchema.extend({
  cf_agents_schedules: ScheduleProjectionState.default({}),
});
export type ReducedStreamState = z.infer<typeof ReducedStreamState>;

export function hydrateReducedStreamState(args: {
  persistedStateJson: string;
  ctx: DurableObjectState;
}): ReducedStreamState {
  const rawState = JSON.parse(args.persistedStateJson);
  const parsedReducedState = ReducedStreamState.safeParse(rawState);
  if (parsedReducedState.success) {
    return parsedReducedState.data;
  }

  const parsedPublicState = PublicStreamStateSchema.parse(rawState);

  return {
    ...parsedPublicState,
    cf_agents_schedules: readScheduleProjectionStateFromTable(args.ctx),
  };
}

export function projectPublicStreamState(
  state: ReducedStreamState | null,
): PublicStreamState | null {
  if (state == null) {
    return null;
  }

  return {
    projectSlug: state.projectSlug,
    path: state.path,
    eventCount: state.eventCount,
    childPaths: state.childPaths,
    metadata: state.metadata,
    processors: state.processors,
  };
}
