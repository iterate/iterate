import { z } from "zod";
import {
  StreamProcessor,
  type StreamProcessorConstructorArgs,
} from "../streams/stream-processor.ts";
import type { RepoFilesSnapshot } from "../repos/repo-durable-object.ts";
import type { WorkerBuildArtifactStore } from "./artifact-store.ts";
import { materializeWorkerBuild } from "./materialize.ts";
import {
  WorkerBuildProcessorContract,
  type WorkerBuildFailurePhase,
} from "./worker-build-processor-contract.ts";

type RequestedPayload = z.output<
  (typeof WorkerBuildProcessorContract)["events"]["events.iterate.com/worker-build/requested"]["payloadSchema"]
>;

type RepoSnapshotResolver = (source: {
  branch?: string;
  commitOid: string;
  exclude?: string[];
  include?: string[];
  repoPath: string;
}) => Promise<RepoFilesSnapshot>;

/**
 * A crashed or evicted in-flight build leaves its `pendingBuilds` claim
 * behind. A `requested` event arriving this long after the claim re-claims
 * the key and retries, so one dead isolate cannot wedge a build key forever.
 *
 * Deliberately LONGER than the resolver's 120s build-wait timeout
 * (worker-loader.ts): a caller that times out and re-requests while a slow
 * cold build (npm installs) is still legitimately running must dedupe against
 * it, not start a duplicate bundler run.
 */
const STALE_PENDING_BUILD_MS = 300_000;

/**
 * Owns the build lifecycle on the ITX scope stream named by
 * `DynamicWorkerRef.path`: consumes `worker-build/requested`, resolves the
 * file source, materializes through Cloudflare's bundler, stores the artifact
 * in the artifact store, and appends the terminal `completed`/`failed` fact.
 * Requests are deduped by build key so concurrent cold callers converge on
 * one build.
 */
export class WorkerBuildProcessor extends StreamProcessor<typeof WorkerBuildProcessorContract> {
  readonly contract = WorkerBuildProcessorContract;
  readonly #artifactStore: WorkerBuildArtifactStore;
  readonly #repoSnapshot: RepoSnapshotResolver;

  constructor(
    args: StreamProcessorConstructorArgs<typeof WorkerBuildProcessorContract, object> & {
      artifactStore: WorkerBuildArtifactStore;
      repoSnapshot: RepoSnapshotResolver;
    },
  ) {
    super(args);
    this.#artifactStore = args.artifactStore;
    this.#repoSnapshot = args.repoSnapshot;
  }

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof WorkerBuildProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/worker-build/requested": {
        // First request claims the key; later requests are concurrent callers
        // converging on the in-flight build and leave the claim alone — a
        // refreshed timestamp would keep pushing the stale window out and a
        // dead build could never be retried. Only a request arriving after
        // the stale window re-claims (that request IS the retry).
        const existing = state.pendingBuilds[event.payload.buildKey];
        if (
          existing !== undefined &&
          Date.parse(event.createdAt) - Date.parse(existing.requestedAt) < STALE_PENDING_BUILD_MS
        ) {
          return state;
        }
        return {
          pendingBuilds: {
            ...state.pendingBuilds,
            [event.payload.buildKey]: {
              claimedAtOffset: event.offset,
              requestedAt: event.createdAt,
            },
          },
        };
      }
      case "events.iterate.com/worker-build/completed":
      case "events.iterate.com/worker-build/failed": {
        const pendingBuilds = { ...state.pendingBuilds };
        delete pendingBuilds[event.payload.buildKey];
        return { pendingBuilds };
      }
      default:
        return state;
    }
  }

  protected override processEvent({
    event,
    runInBackground,
    state,
  }: Parameters<
    StreamProcessor<typeof WorkerBuildProcessorContract>["processEvent"]
  >[0]): undefined {
    if (event.type !== "events.iterate.com/worker-build/requested") return;

    // The fold owns dedupe: build only when THIS event's fold claimed the key.
    if (state.pendingBuilds[event.payload.buildKey]?.claimedAtOffset !== event.offset) return;

    runInBackground(() => this.#build(event.payload, event.offset));
  }

  async #build(payload: RequestedPayload, requestedOffset: number): Promise<void> {
    const { buildKey } = payload;
    let phase: z.output<typeof WorkerBuildFailurePhase> = "resolve-source";
    try {
      // A prior request may have finished between the caller's cache check and
      // this event; the artifact store is the source of truth, so a hit only
      // needs the completion fact re-announced.
      const cached = await this.#artifactStore.get(buildKey);
      if (cached !== null) {
        await this.#appendCompleted({
          buildKey,
          mainModule: cached.mainModule,
          moduleNames: Object.keys(cached.modules).sort(),
          requestedOffset,
        });
        return;
      }

      const files =
        payload.source.type === "inline"
          ? payload.source.files
          : (await this.#repoSnapshot(payload.source)).files;

      phase = "bundle";
      const built = await materializeWorkerBuild({ files, options: payload.options });

      phase = "store-artifact";
      await this.#artifactStore.put({
        buildKey,
        mainModule: built.mainModule,
        modules: built.modules,
      });

      await this.#appendCompleted({
        buildKey,
        mainModule: built.mainModule,
        moduleNames: Object.keys(built.modules).sort(),
        requestedOffset,
        warnings: built.warnings.length > 0 ? built.warnings : undefined,
      });
    } catch (error) {
      await this.stream.append({
        type: "events.iterate.com/worker-build/failed",
        idempotencyKey: `worker-build/failed:${buildKey}:${requestedOffset}`,
        payload: {
          buildKey,
          message: String(error instanceof Error ? error.message : error).slice(0, 4_000),
          phase,
        },
      });
    }
  }

  async #appendCompleted(input: {
    buildKey: string;
    mainModule: string;
    moduleNames: string[];
    requestedOffset: number;
    warnings?: string[];
  }): Promise<void> {
    await this.stream.append({
      type: "events.iterate.com/worker-build/completed",
      idempotencyKey: `worker-build/completed:${input.buildKey}:${input.requestedOffset}`,
      payload: {
        buildKey: input.buildKey,
        mainModule: input.mainModule,
        moduleNames: input.moduleNames,
        ...(input.warnings === undefined ? {} : { warnings: input.warnings }),
      },
    });
  }
}
