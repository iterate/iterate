import { z } from "zod";
import {
  defineProcessorContract,
  implementProcessor,
  reduceProcessorEvents,
  type StreamEvent,
} from "@iterate-com/shared/stream-processors";
import { StreamPath } from "@iterate-com/shared/streams/types";

export const PROJECT_LIFECYCLE_STREAM_PATH = StreamPath.parse("/");

export const ProjectLifecycleProcessorContract = defineProcessorContract({
  slug: "project",
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
    "events.iterate.com/project/created": {
      description: "A Project was created and its initial platform hosts were recorded.",
      payloadSchema: z.object({
        defaultHost: z.string().trim().min(1),
        hosts: z.array(z.string().trim().min(1)),
        projectId: z.string().trim().min(1),
        slug: z.string().trim().min(1),
      }),
    },
  },
  consumes: ["events.iterate.com/project/created"],
  emits: [],
  reduce({ state, event }) {
    switch (event.type) {
      case "events.iterate.com/project/created":
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
