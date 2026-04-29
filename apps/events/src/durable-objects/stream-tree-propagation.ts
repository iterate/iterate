import {
  type Event,
  type ProjectSlug,
  STREAM_CHILD_STREAM_CREATED_TYPE,
  type StreamPath,
} from "@iterate-com/events-contract";
import { getAncestorStreamPaths } from "~/lib/stream-path-ancestors.ts";
import { getInitializedStreamStub } from "~/lib/stream-helpers.ts";

/**
 * Propagates a newly initialized stream to every ancestor as a
 * `child-stream-created` event.
 *
 * This remains stream-core behavior rather than a processor because it defines
 * the stream tree itself. Ordinary processors can observe the resulting events,
 * but they should not own parent/child topology.
 */
export async function propagateInitializedStreamToAncestors(args: {
  childInitializedEvent: Event;
  projectSlug: ProjectSlug;
}) {
  const ancestorPaths = getAncestorStreamPaths(args.childInitializedEvent.streamPath);

  await Promise.all(
    ancestorPaths.map(async (path) => {
      const stream = await getInitializedStreamStub({
        projectSlug: args.projectSlug,
        path,
      });
      await stream.append({
        type: STREAM_CHILD_STREAM_CREATED_TYPE,
        payload: { childPath: args.childInitializedEvent.streamPath as StreamPath },
        metadata: args.childInitializedEvent.metadata,
      });
    }),
  );
}
