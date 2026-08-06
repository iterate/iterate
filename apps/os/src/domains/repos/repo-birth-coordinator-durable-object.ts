import { DurableObject } from "cloudflare:workers";
import { isStreamIdMismatchError, type EmittedInput, type StreamEvent } from "iterate/processors";
import { z } from "zod";
import { trustedInternalAuthContext } from "../../auth.ts";
import { parseConfig } from "../../config.ts";
import { workerVersion, type Env } from "../../env.ts";
import { timedStep } from "../../lib/step-timing.ts";
import { StreamRpcTarget } from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { isRetryableDurableObjectAvailabilityError } from "../streams/stream-unavailable.ts";
import { getOrCreateArtifact } from "./artifact-creation.ts";
import { artifactWriteToken, seedArtifactRepo } from "./artifact-seeding.ts";
import { projectRepoSeedFiles } from "./project-repo-seed.ts";
import { RepoProcessorContract, type RepoCreateRequest } from "./repo-processor-contract.ts";
import { REPO_DEFAULT_BRANCH } from "./repo-defaults.ts";
import {
  isRepoNotSeededError,
  isRetryableArtifactsInfrastructureError,
  RepoArtifactNameCodec,
  RetryableRepoCreationError,
} from "./utils.ts";

const CREATION_HANDOFF_DELAY_MS = 1_000;
const CREATION_RETRY_DELAY_MS = 10_000;
const MAX_CREATION_ATTEMPTS = 5;
const COORDINATED_ARTIFACT_RECOVERY_TIMEOUT_MS = 75_000;

const RepoBirthHandoffInput = z.strictObject({
  request: RepoProcessorContract.events["events.iterate.com/repos/create-requested"].payloadSchema,
  streamId: z.string().min(1),
});
const MaterializedEmptyArtifact = z.strictObject({
  artifactName: z.string().min(1),
  defaultBranch: z.string().min(1),
  remote: z.string().url(),
  seededHead: z
    .strictObject({
      branch: z.string().min(1),
      commitOid: z.string().min(1),
      contentHash: z.string().min(1),
    })
    .optional(),
});
const QueuedRepoBirth = RepoBirthHandoffInput.extend({
  failedAttempts: z.number().int().nonnegative(),
  materializedArtifact: MaterializedEmptyArtifact.optional(),
});

type RepoBirthHandoff = {
  request: Extract<RepoCreateRequest, { type: "empty" }>;
  streamId: string;
};
type MaterializedEmptyArtifact = z.infer<typeof MaterializedEmptyArtifact>;
type QueuedRepoBirth = RepoBirthHandoff & {
  failedAttempts: number;
  materializedArtifact?: MaterializedEmptyArtifact;
};
type RepoBirthTerminal = EmittedInput<RepoProcessorContract> & {
  type: "events.iterate.com/repos/created" | "events.iterate.com/repos/create-failed";
};

type RepoBirthCoordinatorDeps = {
  append(streamId: string, event: RepoBirthTerminal): Promise<void>;
  deleteQueue(): void;
  getAlarm(): Promise<number | null>;
  getEventPage(): Promise<{ events: StreamEvent[]; streamId: string }>;
  getQueue(): unknown;
  isRetryableError(error: unknown): boolean;
  materialize(): Promise<MaterializedEmptyArtifact>;
  now(): number;
  putQueue(queued: QueuedRepoBirth): void;
  setAlarm(scheduledTime: number): Promise<void>;
};

export function isRetryableRepoBirthError(error: unknown): boolean {
  return (
    error instanceof RetryableRepoCreationError ||
    isRepoNotSeededError(error) ||
    isRetryableArtifactsInfrastructureError(error) ||
    isRetryableDurableObjectAvailabilityError(error)
  );
}

/**
 * Durable empty-repo creation state machine, split from the Worker wrapper so
 * its queue/checkpoint semantics can be exercised without mocking Cloudflare.
 */
export class RepoBirthCoordinator {
  constructor(readonly deps: RepoBirthCoordinatorDeps) {}

  async enqueue(input: RepoBirthHandoff): Promise<void> {
    const handoff = parseHandoff(input);
    const stored = this.deps.getQueue();
    if (stored !== undefined) {
      const existing = parseQueuedBirth(stored);
      if (existing.streamId !== handoff.streamId) {
        throw new Error("A different empty-repo creation handoff is already queued.");
      }
      await this.#ensureAlarm();
      return;
    }

    this.deps.putQueue({ ...handoff, failedAttempts: 0 });
    await this.#ensureAlarm();
  }

  async alarm(): Promise<void> {
    const stored = this.deps.getQueue();
    if (stored === undefined) return;
    const queued = parseQueuedBirth(stored);
    let active = queued;

    try {
      const page = await this.deps.getEventPage();
      if (page.streamId !== queued.streamId) {
        this.deps.deleteQueue();
        return;
      }

      const request = page.events.find(
        (event) => event.type === "events.iterate.com/repos/create-requested",
      );
      if (request === undefined) {
        throw new Error("The queued empty-repo creation has no durable create-requested fact.");
      }
      const parsedRequest = RepoProcessorContract.parseEvent(request);
      if (
        parsedRequest.type !== "events.iterate.com/repos/create-requested" ||
        parsedRequest.payload.type !== "empty"
      ) {
        throw new Error("The queued empty-repo creation does not match its request fact.");
      }
      if (
        page.events.some(
          (event) =>
            event.type === "events.iterate.com/repos/created" ||
            event.type === "events.iterate.com/repos/create-failed",
        )
      ) {
        this.deps.deleteQueue();
        return;
      }

      let artifact = queued.materializedArtifact;
      if (artifact === undefined) {
        try {
          artifact = await this.deps.materialize();
        } catch (error) {
          if (this.deps.isRetryableError(error)) throw error;
          await this.deps.append(queued.streamId, {
            type: "events.iterate.com/repos/create-failed",
            idempotencyKey: `${RepoProcessorContract.slug}/create-failed`,
            payload: {
              error: error instanceof Error ? error.message : String(error),
              request: queued.request,
            },
          });
          this.deps.deleteQueue();
          return;
        }
        // The Artifact and seed may be durable before the Stream append
        // acknowledges. Persist their exact result first so recovery never
        // repeats vendor work merely because the terminal acknowledgement died.
        active = { ...queued, materializedArtifact: artifact };
        this.deps.putQueue(active);
      }

      await this.deps.append(queued.streamId, {
        type: "events.iterate.com/repos/created",
        idempotencyKey: `${RepoProcessorContract.slug}/created`,
        payload: { ...artifact, request: queued.request },
      });
      this.deps.deleteQueue();
    } catch (error) {
      if (isStreamIdMismatchError(error)) {
        this.deps.deleteQueue();
        return;
      }
      if (!this.deps.isRetryableError(error)) throw error;

      const failedAttempts = active.failedAttempts + 1;
      if (failedAttempts < MAX_CREATION_ATTEMPTS) {
        active = { ...active, failedAttempts };
        this.deps.putQueue(active);
        console.info("empty repo creation will retry after a classified outage", {
          failedAttempts,
          maxAttempts: MAX_CREATION_ATTEMPTS,
        });
        await this.deps.setAlarm(this.deps.now() + CREATION_RETRY_DELAY_MS);
        return;
      }

      try {
        await this.deps.append(queued.streamId, {
          type: "events.iterate.com/repos/create-failed",
          idempotencyKey: `${RepoProcessorContract.slug}/create-failed`,
          payload: {
            error: `Empty repo creation failed after ${MAX_CREATION_ATTEMPTS} attempts: ${
              error instanceof Error ? error.message : String(error)
            }`,
            request: active.request,
          },
        });
        this.deps.deleteQueue();
      } catch (appendError) {
        if (isStreamIdMismatchError(appendError)) {
          this.deps.deleteQueue();
          return;
        }
        throw appendError;
      }
    }
  }

  async #ensureAlarm(): Promise<void> {
    if ((await this.deps.getAlarm()) !== null) return;
    await this.deps.setAlarm(this.deps.now() + CREATION_HANDOFF_DELAY_MS);
  }
}

/**
 * One independent alarm actor per repo creation saga. It never calls the Repo
 * actor: doing that from the Repo processor's retained Stream callback would
 * recreate the Repo→Stream actor-drain cycle. The alarm materializes the
 * Artifact directly, checkpoints it, then appends through the stream fence.
 */
export class RepoBirthCoordinatorDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!, { allowNullProjectId: true });
  readonly #stream = new StreamRpcTarget({
    auth: trustedInternalAuthContext(),
    path: this.#name.path,
    projectId: this.#name.projectId,
  });
  readonly #coordinator = new RepoBirthCoordinator({
    append: (streamId, event) => this.#append(streamId, event),
    deleteQueue: () => void this.ctx.storage.kv.delete("repo-birth:queued"),
    getAlarm: () => this.ctx.storage.getAlarm(),
    getEventPage: async () =>
      await this.#stream.getEventPage({
        eventTypes: [
          "events.iterate.com/repos/create-requested",
          "events.iterate.com/repos/created",
          "events.iterate.com/repos/create-failed",
        ],
      }),
    getQueue: () => this.ctx.storage.kv.get<unknown>("repo-birth:queued"),
    isRetryableError: isRetryableRepoBirthError,
    materialize: () => this.#materialize(),
    now: () => Date.now(),
    putQueue: (queued) => void this.ctx.storage.kv.put("repo-birth:queued", queued),
    setAlarm: (scheduledTime) => this.ctx.storage.setAlarm(scheduledTime),
  });

  deploymentVersion(): string {
    return workerVersion(this.env);
  }

  enqueue(input: RepoBirthHandoff): Promise<void> {
    return this.#coordinator.enqueue(input);
  }

  alarm(): Promise<void> {
    return this.#coordinator.alarm();
  }

  async #materialize(): Promise<MaterializedEmptyArtifact> {
    const artifactName = RepoArtifactNameCodec.stringify(this.#name);
    const defaultBranch = REPO_DEFAULT_BRANCH;
    const remote = `https://${this.env.ARTIFACTS_ACCOUNT_ID}.artifacts.cloudflare.net/git/${this.env.ARTIFACTS_NAMESPACE}/${artifactName}.git`;
    const timing = { path: this.#name.path, projectId: this.#name.projectId };
    const artifact = await timedStep("create-timing", timing, "artifact-get-or-create", () =>
      getOrCreateArtifact(this.env.ARTIFACTS, artifactName, {
        // This alarm owns the operation independently of the retained stream
        // callback. Await create() itself: abandoning its successful response
        // would discard the one-time initial write token. Only an ambiguous
        // ALREADY_EXISTS readback is bounded.
        createTimeoutMs: null,
        defaultBranch,
        recoveryTimeoutMs: COORDINATED_ARTIFACT_RECOVERY_TIMEOUT_MS,
      }),
    );
    if (artifact.branchState === "has-commits") {
      return { artifactName, defaultBranch, remote };
    }

    const token =
      artifact.initialWriteToken ||
      (await timedStep("create-timing", timing, "artifact-token", () =>
        artifactWriteToken(this.env.ARTIFACTS, artifactName),
      ));
    const seeded = await timedStep("create-timing", timing, "artifact-seed", () =>
      seedArtifactRepo({
        branch: defaultBranch,
        files: projectRepoSeedFiles(parseConfig(this.env)),
        remote,
        token,
      }),
    );
    return {
      artifactName,
      defaultBranch,
      remote,
      seededHead: { branch: defaultBranch, ...seeded },
    };
  }

  async #append(streamId: string, event: RepoBirthTerminal): Promise<void> {
    await this.#stream.appendIfStreamId({
      events: [
        {
          ...event,
          source: {
            processor: {
              slug: RepoProcessorContract.slug,
              version: RepoProcessorContract.version,
              stream: {
                path: this.#name.path,
                projectId: this.#name.projectId,
                streamId,
              },
            },
          },
        },
      ],
      streamId,
    });
  }
}

function parseHandoff(input: unknown): RepoBirthHandoff {
  const parsed = RepoBirthHandoffInput.parse(input);
  if (parsed.request.type !== "empty") {
    throw new Error("The repo birth coordinator accepts only empty creation requests.");
  }
  return { request: parsed.request, streamId: parsed.streamId };
}

function parseQueuedBirth(input: unknown): QueuedRepoBirth {
  const parsed = QueuedRepoBirth.parse(input);
  if (parsed.request.type !== "empty") {
    throw new Error("The repo birth coordinator accepts only empty creation requests.");
  }
  return { ...parsed, request: parsed.request };
}
