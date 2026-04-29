import {
  type ChildStreamCreatedEvent,
  type Event,
  type ProjectSlug,
  STREAM_CHILD_STREAM_CREATED_TYPE,
  STREAM_METADATA_UPDATED_TYPE,
  type StreamMetadataUpdatedEvent,
  StreamPath,
  StreamState,
} from "@iterate-com/events-contract";
import { createInitialBuiltinProcessorState } from "./builtin-processors.ts";

export function createInitialStreamState(args: {
  projectSlug: ProjectSlug;
  path: StreamPath;
}): StreamState {
  return {
    projectSlug: args.projectSlug,
    path: args.path,
    eventCount: 0,
    childPaths: [],
    metadata: {},
    processors: createInitialBuiltinProcessorState(),
  };
}

/**
 * Reduces only top-level stream-owned state.
 *
 * Builtin processor slices live under `state.processors` and are reduced by
 * `builtin-processors.ts`; this module owns the structural stream fields that
 * cannot move to a remote processor: event count, metadata, and child paths.
 */
export function reduceStreamCore(args: { state: StreamState; event: Event }): StreamState {
  let nextState: StreamState = {
    ...structuredClone(args.state),
    eventCount: args.state.eventCount + 1,
  };

  switch (args.event.type) {
    case STREAM_METADATA_UPDATED_TYPE: {
      const metadataUpdatedEvent = args.event as StreamMetadataUpdatedEvent;
      nextState = { ...nextState, metadata: metadataUpdatedEvent.payload.metadata };
      break;
    }
    case STREAM_CHILD_STREAM_CREATED_TYPE: {
      const childPath = getImmediateChildPath({
        parentPath: args.state.path,
        childPath: (args.event as ChildStreamCreatedEvent).payload.childPath,
      });
      if (childPath != null && !nextState.childPaths.includes(childPath)) {
        nextState = { ...nextState, childPaths: [...nextState.childPaths, childPath] };
      }
      break;
    }
  }

  return nextState;
}

function getImmediateChildPath(args: {
  parentPath: StreamPath;
  childPath: StreamPath;
}): StreamPath | null {
  if (args.childPath === args.parentPath) {
    return null;
  }

  if (args.parentPath === "/") {
    const [firstSegment] = args.childPath.split("/").filter(Boolean);
    return firstSegment == null ? null : StreamPath.parse(`/${firstSegment}`);
  }

  const parentPrefix = `${args.parentPath}/`;
  if (!args.childPath.startsWith(parentPrefix)) {
    return null;
  }

  const remainingPath = args.childPath.slice(parentPrefix.length);
  const [firstSegment] = remainingPath.split("/");
  return firstSegment == null ? null : StreamPath.parse(`${args.parentPath}/${firstSegment}`);
}
