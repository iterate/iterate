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
  commitOid: string;
  exclude?: string[];
  include?: string[];
  repoPath: string;
}) => Promise<RepoFilesSnapshot>;

/**
 * A crashed or evicted in-flight build leaves its `pendingBuilds` entry
 * behind. A later `requested` for the same key older than this threshold is
 * treated as a legitimate retry instead of a duplicate, so one dead isolate
 * cannot wedge a build key forever.
 */
const STALE_PENDING_BUILD_MS = 120_000;

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
      case "events.iterate.com/worker-build/requested":
        return {
          pendingBuilds: {
            ...state.pendingBuilds,
            [event.payload.buildKey]: event.createdAt,
          },
        };
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
    previousState,
    runInBackground,
  }: Parameters<
    StreamProcessor<typeof WorkerBuildProcessorContract>["processEvent"]
  >[0]): undefined {
    if (event.type !== "events.iterate.com/worker-build/requested") return;

    // Dedupe by build key: a request while the same key is already pending is
    // a concurrent caller converging on the in-flight build — unless that
    // pending entry is old enough to be a dead build, in which case this
    // request IS the retry.
    const pendingSince = previousState.pendingBuilds[event.payload.buildKey];
    if (
      pendingSince !== undefined &&
      Date.parse(event.createdAt) - Date.parse(pendingSince) < STALE_PENDING_BUILD_MS
    ) {
      return;
    }

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
        compatibilityDate: built.compatibilityDate,
        compatibilityFlags: built.compatibilityFlags,
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
