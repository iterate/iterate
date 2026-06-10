// The "project" processor: the event-sourced record of a Project's life,
// hosted on ProjectDurableObject via createStreamProcessorHost.
//
// Creation is a request followed by observable steps, not a method body:
//
//   project/create-requested   { projectId, slug }            — the form values
//   project/created            { projectId, slug, hosts, … }  — registered, hosts assigned
//   project/config-worker-built{ commitOid, … }               — worker built (also re-fires
//                                                               on later rebuilds)
//   project/create-completed   { projectId }                  — registration done
//
// `reduce` projects these into state (the DO keeps no project table of its
// own — this snapshot IS the project's durable state); `processEvent` drives
// the side effects for `create-requested` through the deps the hosting DO
// provides, each step idempotent so at-least-once delivery is safe. The
// worker build deliberately does NOT gate create-completed: ingress requests
// build on demand, so a failed build self-heals on the next request.
//
// The processor also forwards every live event on the project's root stream
// to the project worker's optional `processEvent` hook — user code reacting
// to its project's events.

import { z } from "zod";
import { StreamProcessor } from "@iterate-com/streams/stream-processor";
import {
  assertNever,
  defineProcessorContract,
} from "@iterate-com/streams/shared/stream-processors";
import type { StreamEvent } from "@iterate-com/streams/shared/event";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { ITERATE_CONFIG_REPO_SLUG } from "~/domains/repos/iterate-config-repo.ts";

export const PROJECT_STREAM_PATH = StreamPath.parse("/");

export const PROJECT_CREATE_REQUESTED_EVENT_TYPE = "events.iterate.com/project/create-requested";
export const PROJECT_CREATED_EVENT_TYPE = "events.iterate.com/project/created";
// Historical type string ("config worker" is now just "the worker").
export const WORKER_BUILT_EVENT_TYPE = "events.iterate.com/project/config-worker-built";
export const PROJECT_CREATE_COMPLETED_EVENT_TYPE = "events.iterate.com/project/create-completed";

/** What the created event records; also the project's summary shape. */
const ProjectFacts = z.object({
  defaultHost: z.string().trim().min(1),
  hosts: z.array(z.string().trim().min(1)),
  projectId: z.string().trim().min(1),
  slug: z.string().trim().min(1),
});

export type ProjectFacts = z.infer<typeof ProjectFacts>;

export const ProjectProcessorContract = defineProcessorContract({
  slug: "project",
  version: "0.2.0",
  description: "Projects the Project's lifecycle events and drives creation side effects.",
  stateSchema: z.object({
    phase: z.enum(["none", "creating", "ready"]).default("none"),
    project: ProjectFacts.nullable().default(null),
    worker: z
      .object({
        commitOid: z.string().trim().min(1),
        mainModule: z.string().trim().min(1),
        repoSlug: z.string().trim().min(1),
      })
      .nullable()
      .default(null),
  }),
  initialState: {
    phase: "none",
    project: null,
    worker: null,
  },
  events: {
    [PROJECT_CREATE_REQUESTED_EVENT_TYPE]: {
      description: "Project creation was requested with these form values.",
      payloadSchema: z.object({
        projectId: z.string().trim().min(1),
        slug: z.string().trim().min(1),
      }),
    },
    [PROJECT_CREATED_EVENT_TYPE]: {
      description: "The Project was registered and its platform hosts were assigned.",
      payloadSchema: ProjectFacts,
    },
    [WORKER_BUILT_EVENT_TYPE]: {
      description: "The Project's worker was built and cached for dispatch.",
      payloadSchema: z.object({
        commitOid: z.string().trim().min(1),
        mainModule: z.string().trim().min(1),
        projectId: z.string().trim().min(1),
        repoSlug: z.string().trim().min(1),
      }),
    },
    [PROJECT_CREATE_COMPLETED_EVENT_TYPE]: {
      description: "All Project creation steps completed.",
      payloadSchema: z.object({
        projectId: z.string().trim().min(1),
      }),
    },
  },
  consumes: [
    PROJECT_CREATE_REQUESTED_EVENT_TYPE,
    PROJECT_CREATED_EVENT_TYPE,
    WORKER_BUILT_EVENT_TYPE,
    PROJECT_CREATE_COMPLETED_EVENT_TYPE,
  ],
  emits: [PROJECT_CREATED_EVENT_TYPE, WORKER_BUILT_EVENT_TYPE, PROJECT_CREATE_COMPLETED_EVENT_TYPE],
});

export type ProjectProcessorContract = typeof ProjectProcessorContract;

export type ProjectProcessorState = z.infer<typeof ProjectProcessorContract.stateSchema>;

/** The side-effect verbs the hosting Durable Object provides. */
export type ProjectProcessorDeps = {
  creation: {
    /** Compute the project's hosts/summary (pure — hosts derive from config). */
    summarize(input: { projectId: string; slug: string }): ProjectFacts;
    ensureExampleEgressSecret(input: { projectId: string }): Promise<void>;
    ensureAgentsRoot(input: { projectId: string }): Promise<void>;
    writeAgentsRootRule(input: { projectId: string }): Promise<void>;
    buildWorker(input: {
      projectId: string;
      slug: string;
    }): Promise<{ commitOid: string; mainModule: string }>;
  };
  /** Best-effort delivery to the project worker's `processEvent` hook. */
  forwardEventToWorker(event: StreamEvent): Promise<void>;
};

export class ProjectProcessor extends StreamProcessor<
  ProjectProcessorContract,
  ProjectProcessorDeps
> {
  readonly contract = ProjectProcessorContract;

  protected override reduce(
    args: Parameters<StreamProcessor<ProjectProcessorContract>["reduce"]>[0],
  ): ProjectProcessorState {
    const { event, state } = args;
    switch (event.type) {
      case PROJECT_CREATE_REQUESTED_EVENT_TYPE:
        return { ...state, phase: state.phase === "ready" ? state.phase : "creating" };
      case PROJECT_CREATED_EVENT_TYPE:
        return { ...state, project: event.payload };
      case WORKER_BUILT_EVENT_TYPE:
        return {
          ...state,
          worker: {
            commitOid: event.payload.commitOid,
            mainModule: event.payload.mainModule,
            repoSlug: event.payload.repoSlug,
          },
        };
      case PROJECT_CREATE_COMPLETED_EVENT_TYPE:
        return { ...state, phase: "ready" };
      default:
        return assertNever(event);
    }
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<ProjectProcessorContract>["processEvent"]>[0],
  ): void {
    const { event } = args;
    if (event.type !== PROJECT_CREATE_REQUESTED_EVENT_TYPE) return;
    const { projectId, slug } = event.payload;

    args.blockProcessorWhile(async () => {
      const facts = this.deps.creation.summarize({ projectId, slug });
      await this.ctx.stream.append({
        event: {
          type: PROJECT_CREATED_EVENT_TYPE,
          idempotencyKey: `project-created:${projectId}`,
          payload: facts,
        },
      });
      await this.deps.creation.ensureExampleEgressSecret({ projectId });
      await this.deps.creation.ensureAgentsRoot({ projectId });
      await this.deps.creation.writeAgentsRootRule({ projectId });
      await this.ctx.stream.append({
        event: {
          type: PROJECT_CREATE_COMPLETED_EVENT_TYPE,
          idempotencyKey: `project-create-completed:${projectId}`,
          payload: { projectId },
        },
      });
    });

    // The build is observable (worker-built event) but never gates creation:
    // ingress builds on demand, so a failure here self-heals on next request.
    args.runInBackground(async () => {
      const built = await this.deps.creation.buildWorker({ projectId, slug });
      await this.ctx.stream.append({
        event: {
          type: WORKER_BUILT_EVENT_TYPE,
          idempotencyKey: `project-config-worker-built:${projectId}:${built.commitOid}`,
          payload: {
            commitOid: built.commitOid,
            mainModule: built.mainModule,
            projectId,
            repoSlug: ITERATE_CONFIG_REPO_SLUG,
          },
        },
      });
    });
  }

  protected override async processEventBatch(
    args: Parameters<StreamProcessor<ProjectProcessorContract>["processEventBatch"]>[0],
  ): Promise<void> {
    await super.processEventBatch(args);
    // Forward EVERY live event (consumed or not) to the project worker.
    for (const event of args.events) {
      if (event.offset <= args.sideEffectsAfterOffset) continue;
      args.runInBackground(() => this.deps.forwardEventToWorker(event));
    }
  }
}
