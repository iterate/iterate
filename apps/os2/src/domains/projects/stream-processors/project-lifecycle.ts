import { z } from "zod";
import {
  defineProcessorContract,
  implementProcessor,
  reduceProcessorEvents,
  type StreamEvent,
} from "@iterate-com/shared/stream-processors";
import { StreamPath } from "@iterate-com/shared/streams/types";

export const PROJECT_LIFECYCLE_STREAM_PATH = StreamPath.parse("/");
const PROJECT_CREATED_EVENT_TYPE = "events.iterate.com/project/created";
export const PROJECT_CONFIG_WORKER_BUILT_EVENT_TYPE =
  "events.iterate.com/project/config-worker-built";
const LEGACY_PROJECT_CREATED_EVENT_TYPE = "events.iterate.com/os2/project-created";

export const ProjectLifecycleProcessorContract = defineProcessorContract({
  slug: "project-lifecycle",
  version: "0.1.0",
  description: "Tracks Project lifecycle facts and provisioning status.",
  stateSchema: z.object({
    project: z
      .object({
        defaultHost: z.string().trim().min(1),
        hosts: z.array(z.string().trim().min(1)),
        projectId: z.string().trim().min(1),
        slug: z.string().trim().min(1),
      })
      .nullable()
      .default(null),
  }),
  initialState: {
    project: null,
  },
  events: {
    [PROJECT_CREATED_EVENT_TYPE]: {
      description: "A Project was created and its initial platform hosts were recorded.",
      payloadSchema: z.object({
        defaultHost: z.string().trim().min(1),
        hosts: z.array(z.string().trim().min(1)),
        projectId: z.string().trim().min(1),
        slug: z.string().trim().min(1),
      }),
    },
    [LEGACY_PROJECT_CREATED_EVENT_TYPE]: {
      description: "A Project was created and its initial platform hosts were recorded.",
      payloadSchema: z.object({
        defaultHost: z.string().trim().min(1),
        hosts: z.array(z.string().trim().min(1)),
        projectId: z.string().trim().min(1),
        slug: z.string().trim().min(1),
      }),
    },
    [PROJECT_CONFIG_WORKER_BUILT_EVENT_TYPE]: {
      description: "The Project iterate-config worker was built and cached for dispatch.",
      payloadSchema: z.object({
        commitOid: z.string().trim().min(1),
        mainModule: z.string().trim().min(1),
        projectId: z.string().trim().min(1),
        repoSlug: z.string().trim().min(1),
      }),
    },
  },
  consumes: [
    PROJECT_CREATED_EVENT_TYPE,
    LEGACY_PROJECT_CREATED_EVENT_TYPE,
    PROJECT_CONFIG_WORKER_BUILT_EVENT_TYPE,
  ],
  emits: [],
  reduce({ state, event }) {
    switch (event.type) {
      case PROJECT_CREATED_EVENT_TYPE:
      case LEGACY_PROJECT_CREATED_EVENT_TYPE:
        return {
          ...state,
          project: event.payload,
        };
    }
  },
});

export type ProjectLifecycleState = z.infer<typeof ProjectLifecycleProcessorContract.stateSchema>;

export function createProjectLifecycleProcessor() {
  return implementProcessor(ProjectLifecycleProcessorContract, {});
}

export function reduceProjectLifecycleEvents(args: {
  events: readonly StreamEvent[];
  state?: ProjectLifecycleState;
}) {
  return reduceProcessorEvents({
    contract: ProjectLifecycleProcessorContract,
    events: args.events,
    state: args.state,
  });
}
