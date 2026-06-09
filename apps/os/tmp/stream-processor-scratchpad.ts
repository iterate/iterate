// @ts-nocheck
//
// Scratchpad for the next stream processor concept.
// This file is intentionally excluded from apps/os typecheck via tmp/**.

import { DurableObject, RpcTarget } from "cloudflare:workers";

/**
 * Desired call sites
 * ------------------
 *
 * The current idea is:
 * - StreamProcessor extends RpcTarget for now.
 * - Project/Repo/etc Durable Objects can embed processors as ordinary instances.
 * - Processor tool methods can be exposed through the DO/capability tree.
 * - Processor event hooks stay synchronous.
 * - Async work inside processEvent must choose a concurrency behavior.
 */

async function desiredExternalCalls(ctx: ProjectScopedIterateContext) {
  await ctx.project.reposProcessor.create({ slug: "iterate-web" });

  await ctx.project.reposProcessor.rename({
    repoId: "repo_123",
    slug: "iterate-os",
  });

  const repoState = await ctx.project.reposProcessor.state();

  await ctx.project.workspacesProcessor.createFolder({
    path: "/src/domains/repos",
  });

  const workspaceState = await ctx.project.workspacesProcessor.state();

  return { repoState, workspaceState };
}

/**
 * Important RPC note
 * ------------------
 *
 * Durable Object RPC docs talk about exposing public methods. Existing local
 * Cap'n Web capability classes use getters returning RpcTargets for nested
 * surfaces such as ctx.project.streams.
 *
 * So this scratchpad treats `ctx.project.reposProcessor` as the desired ergonomic
 * surface, but implementation may need a getter or method that returns the
 * processor RpcTarget rather than a bare public class field on the Durable Object
 * stub.
 */

type StreamProcessorDeps<IterateContext> = {
  iterateContext: IterateContext;
  blockProcessorWhile?: <T>(work: () => Promise<T>) => void;
  runInBackground?: <T>(work: () => Promise<T>) => void;
};

abstract class StreamProcessor<
  Contract,
  Deps extends StreamProcessorDeps<unknown>,
> extends RpcTarget {
  protected readonly ctx: Deps["iterateContext"];

  protected constructor(
    protected readonly input: {
      contract: Contract;
      deps: Deps;
      sql?: SyncSqlite;
    },
  ) {
    super();
    this.ctx = input.deps.iterateContext;
  }

  /**
   * Runner-facing method. This may be async because blocking work delays cursor
   * advancement and later event processing.
   */
  async processEventBatch(args: {
    events: readonly StreamEvent[];
    streamMaxOffset: number;
  }): Promise<void> {
    // Base class should:
    // 1. serialize batches so only one batch processes at a time
    // 2. skip events <= saved cursor
    // 3. reduce raw StreamEvent -> ReducedEvent<Contract>
    // 4. call processEvents({ events: reducedEvents, ... })
    // 5. await any blockProcessorWhile work before saving state/cursor
    // 6. log runInBackground failures without holding the cursor
  }

  /**
   * Batch authoring hook. Override for sync batch projection writes.
   * Async work here is suspicious; prefer per-event processEvent for blocking.
   */
  protected processEvents(args: ProcessEventsArgs<Contract>): void {
    for (const reducedEvent of args.events) {
      this.processEvent({
        ...reducedEvent,
        streamMaxOffset: args.streamMaxOffset,
        blockProcessorWhile: args.blockProcessorWhile,
        runInBackground: args.runInBackground,
      });
    }
  }

  /**
   * Normal authoring hook. This is synchronous. No dangling promises.
   */
  protected processEvent(_args: ProcessEventArgs<Contract>): void {}

  protected reduce(_args: ReduceArgs<Contract>): unknown {
    // Must be deterministic and side-effect-free.
    // We probably want a repo-local ESLint rule for StreamProcessor#reduce.
  }
}

class RepoProcessor extends StreamProcessor<RepoProcessorContract, RepoProcessorDeps> {
  constructor(args: { deps: RepoProcessorDeps; sql?: SyncSqlite }) {
    super({
      contract: RepoProcessorContract,
      deps: args.deps,
      sql: args.sql,
    });
  }

  /**
   * Tool method. Because StreamProcessor extends RpcTarget for now, this can be
   * returned directly from a capability/DO surface.
   */
  async create(args: { slug: string }): Promise<{ repoId: string }> {
    const repoId = makeId("repo");

    await this.ctx.project.streams.appendBatch({
      events: [
        {
          type: "events.iterate.com/repo/creation-requested",
          idempotencyKey: `repo-creation-requested:${repoId}`,
          payload: { repoId, slug: args.slug },
        },
      ],
    });

    return { repoId };
  }

  async rename(args: { repoId: string; slug: string }): Promise<void> {
    await this.ctx.project.streams.append({
      event: {
        type: "events.iterate.com/repo/rename-requested",
        idempotencyKey: `repo-rename-requested:${args.repoId}:${args.slug}`,
        payload: args,
      },
    });
  }

  state(): RepoState {
    // Maybe exposed as a method rather than a property for RPC reliability.
    return this.readState();
  }

  protected processEvent({
    event,
    blockProcessorWhile,
    runInBackground,
  }: ProcessEventArgs<RepoProcessorContract>): void {
    switch (event.type) {
      case "events.iterate.com/repo/creation-requested":
        blockProcessorWhile(async () => {
          const artifact = await this.input.deps.env.ARTIFACTS.get(event.payload.repoId).init();

          await this.ctx.project.streams.append({
            event: {
              type: "events.iterate.com/repo/creation-succeeded",
              idempotencyKey: `repo-creation-succeeded:${event.offset}`,
              payload: {
                repoId: event.payload.repoId,
                artifact,
              },
            },
          });
        });
        break;

      case "events.iterate.com/repo/rename-requested":
        runInBackground(async () => {
          await this.ctx.project.streams.append({
            event: {
              type: "events.iterate.com/repo/renamed",
              idempotencyKey: `repo-renamed:${event.offset}`,
              payload: {
                repoId: event.payload.repoId,
                slug: event.payload.slug,
              },
            },
          });
        });
        break;
    }
  }

  private readState(): RepoState {
    throw new Error("scratchpad");
  }
}

class ProjectDurableObject extends DurableObject<Env> {
  private readonly reposProcessor = new RepoProcessor({
    sql: this.ctx.storage.sql,
    deps: {
      env: this.env,
      iterateContext: this.createProcessorIterateContext(),
      blockProcessorWhile: (work) => this.blockProcessorWhile(work),
      runInBackground: (work) => this.runInBackground(work),
    },
  });

  private readonly workspacesProcessor = new WorkspacesProcessor({
    sql: this.ctx.storage.sql,
    deps: {
      env: this.env,
      iterateContext: this.createProcessorIterateContext(),
      blockProcessorWhile: (work) => this.blockProcessorWhile(work),
      runInBackground: (work) => this.runInBackground(work),
    },
  });

  /**
   * Desired nested capability exposure.
   *
   * If Durable Object RPC does not expose getters directly on stubs, ProjectCapability
   * can expose equivalent getters/methods that return these RpcTargets.
   */
  get reposProcessor(): RepoProcessor {
    return this.reposProcessor;
  }

  get workspacesProcessor(): WorkspacesProcessor {
    return this.workspacesProcessor;
  }

  async processRepoEventBatch(args: {
    events: readonly StreamEvent[];
    streamMaxOffset: number;
  }): Promise<void> {
    await this.reposProcessor.processEventBatch(args);
  }

  async processWorkspaceEventBatch(args: {
    events: readonly StreamEvent[];
    streamMaxOffset: number;
  }): Promise<void> {
    await this.workspacesProcessor.processEventBatch(args);
  }

  private createProcessorIterateContext(): ProjectScopedIterateContext {
    // Should contain a project-scoped and stream-path-narrowed project.streams capability.
    // Processor authoring then uses this.ctx.project.streams only.
    throw new Error("scratchpad");
  }

  private blockProcessorWhile<T>(_work: () => Promise<T>): void {
    // For now this can just register blocking work with the processor base class.
    // Later this should be backed by an alarm/heartbeat keepalive.
  }

  private runInBackground<T>(work: () => Promise<T>): void {
    // No dangling promises in processor code; this is the framework-owned escape hatch.
    // For now: start, catch, log. Later: alarm-backed keepalive.
    work().catch((error: unknown) => {
      console.error("stream processor background work failed", error);
    });
  }
}

/**
 * Dynamic-worker stateless processor sketch
 * -----------------------------------------
 *
 * This is for project config worker code. Today dynamic workers can expose
 * WorkerEntrypoint methods but not project-owned Durable Object facets. The
 * lightweight version should let worker.js register a stateless stream processor
 * method that OS invokes for delivered event batches.
 */

async function desiredDynamicWorkerCode() {
  /*
    import { WorkerEntrypoint } from "cloudflare:workers";

    export default {
      async fetch(request, env, ctx) {
        return new Response("Hello from the project worker");
      },

      async processEventBatch({ events, ctx }) {
        for (const event of events) {
          if (event.type !== "events.iterate.com/stream/child-stream-created") continue;
          if (!event.payload.childPath.startsWith("/repos/")) continue;

          await ctx.project.streams.append({
            path: event.payload.childPath,
            event: {
              type: "events.iterate.com/stream/subscription-configured",
              idempotencyKey: `subscribe-repo-processor:${event.payload.childPath}`,
              payload: {
                subscriptionKey: "repo-processor",
                subscriber: {
                  type: "project-worker-entrypoint",
                  entrypoint: "RepoProcessor",
                },
              },
            },
          });
        }
      },
    };

    export class RepoProcessor extends WorkerEntrypoint {
      async processEventBatch({ events, ctx }) {
        for (const event of events) {
          if (event.type !== "events.iterate.com/repo/creation-succeeded") continue;

          await ctx.project.streams.append({
            path: "/activity",
            event: {
              type: "events.iterate.com/activity/item-added",
              idempotencyKey: `config.repo-created-activity:${event.offset}`,
              payload: {
                message: `Repo ${event.payload.repoId} is ready`,
              },
            },
          });
        }
      }
    }
  */
}

type StatelessProcessorRegistration = {
  method: string;
  processorSlug: string;
  stream: string;
};

class DynamicWorkerStatelessProcessorRunner {
  constructor(
    private readonly input: {
      entrypoint: ProjectDynamicWorkerEntrypoint | WorkerEntrypoint;
      iterateContext: ProjectScopedIterateContext;
    },
  ) {}

  /**
   * Stateless processors do not keep durable reduced state or an independent
   * cursor. Delivery semantics are therefore a subscription policy question:
   * - live-only: call only for new events while the dynamic worker is attached
   * - replay: stream runtime replays from a configured offset each time
   *
   * A lightweight first slice should probably use live-only or explicit
   * replayAfterOffset from the subscription-configured event.
   */
  async processEventBatch(args: {
    events: readonly StreamEvent[];
    method: string;
    streamMaxOffset: number;
  }): Promise<void> {
    const fn = this.input.entrypoint[args.method];
    if (typeof fn !== "function") {
      throw new Error(`Project config worker does not implement ${args.method}.`);
    }

    await fn.call(this.input.entrypoint, {
      ctx: this.input.iterateContext,
      events: args.events,
      streamMaxOffset: args.streamMaxOffset,
    });
  }
}

type ProcessEventsArgs<Contract> = {
  events: readonly ReducedEvent<Contract>[];
  previousState: DeepReadonly<ProcessorState<Contract>>;
  state: DeepReadonly<ProcessorState<Contract>>;
  streamMaxOffset: number;
  blockProcessorWhile: <T>(work: () => Promise<T>) => void;
  runInBackground: <T>(work: () => Promise<T>) => void;
};

type ProcessEventArgs<Contract> = ReducedEvent<Contract> & {
  streamMaxOffset: number;
  blockProcessorWhile: <T>(work: () => Promise<T>) => void;
  runInBackground: <T>(work: () => Promise<T>) => void;
};

type ReducedEvent<Contract> = {
  event: DeepReadonly<ConsumedEvent<Contract>>;
  previousState: DeepReadonly<ProcessorState<Contract>>;
  state: DeepReadonly<ProcessorState<Contract>>;
};

type ReduceArgs<Contract> = {
  event: DeepReadonly<ConsumedEvent<Contract>>;
  state: DeepReadonly<ProcessorState<Contract>>;
};

/**
 * Placeholder types below this line.
 */

declare const RepoProcessorContract: RepoProcessorContract;

type RepoProcessorContract = unknown;
type RepoProcessorDeps = StreamProcessorDeps<ProjectScopedIterateContext> & {
  env: Pick<Env, "ARTIFACTS">;
};

type ProjectScopedIterateContext = {
  project: {
    streams: {
      append(args: { event: StreamEventInput; path?: string }): Promise<unknown>;
      appendBatch(args: { events: readonly StreamEventInput[]; path?: string }): Promise<unknown>;
      read(args?: { path?: string }): Promise<unknown>;
    };
  };
};

type WorkspacesProcessor = StreamProcessor<
  unknown,
  StreamProcessorDeps<ProjectScopedIterateContext>
>;
declare const WorkspacesProcessor: {
  new (args: {
    deps: StreamProcessorDeps<ProjectScopedIterateContext> & { env: Env };
    sql?: SyncSqlite;
  }): WorkspacesProcessor;
};

type SyncSqlite = unknown;
type StreamEvent = StreamEventInput & { createdAt: string; offset: number };
type StreamEventInput = { idempotencyKey?: string; payload: unknown; type: string };
type ProcessorState<Contract> = unknown;
type ConsumedEvent<Contract> = StreamEvent;
type DeepReadonly<T> = T;
type RepoState = unknown;

type Env = {
  ARTIFACTS: {
    get(repoId: string): {
      init(): Promise<unknown>;
    };
  };
};

function makeId(prefix: string): string {
  return `${prefix}_scratchpad`;
}
