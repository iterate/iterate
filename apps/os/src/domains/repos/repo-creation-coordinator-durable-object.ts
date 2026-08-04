import { DurableObject } from "cloudflare:workers";
import { isStreamIdMismatchError } from "iterate/processors";
import { z } from "zod";
import { trustedInternalAuthContext } from "../../auth.ts";
import { workerVersion, type Env } from "../../env.ts";
import { StreamRpcTarget } from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { internalStreamId } from "../streams/stream-delivery-utils.ts";
import { isRetryableDurableObjectAvailabilityError } from "../streams/stream-unavailable.ts";
import { createGithubTemplateArtifact } from "./github-template-creation.ts";
import {
  createGithubTemplateSource,
  isRetryableGithubTemplateSourceError,
} from "./github-template-source.ts";
import {
  RepoProcessorContract,
  type RepoCreateRequest,
  type RepoProcessorState,
} from "./repo-processor-contract.ts";
import {
  RepoArtifactNameCodec,
  isRepoNotSeededError,
  isRetryableArtifactsInfrastructureError,
} from "./utils.ts";

const QUEUED_CREATION_STORAGE_KEY = "repo-creation:queued";
const CREATION_HANDOFF_DELAY_MS = 1_000;
const CREATION_RETRY_DELAY_MS = 60_000;
const RepoTemplateCreationHandoffInput = z.strictObject({
  request: RepoProcessorContract.events["events.iterate.com/repos/create-requested"].payloadSchema,
  streamId: z.string().min(1),
});

type RepoTemplateCreationHandoff = {
  request: Extract<RepoCreateRequest, { type: "github-public-template" }>;
  streamId: string;
};

function parseHandoff(input: unknown): RepoTemplateCreationHandoff {
  const parsed = RepoTemplateCreationHandoffInput.parse(input);
  if (parsed.request.type !== "github-public-template") {
    throw new Error("The repo creation coordinator accepts only public-template requests.");
  }
  return { request: parsed.request, streamId: parsed.streamId };
}

function isRetryableCreationAttemptError(error: unknown): boolean {
  return (
    isRepoNotSeededError(error) ||
    isRetryableArtifactsInfrastructureError(error) ||
    isRetryableDurableObjectAvailabilityError(error) ||
    isRetryableGithubTemplateSourceError(error)
  );
}

/**
 * One independent alarm actor per public-template creation saga.
 *
 * The Repo processor runs inside a callback retained by the source Stream DO.
 * Calling the Repo actor from an alarm creates the same actor-drain cycle and
 * Cloudflare cancels the alarm. This object therefore owns the whole template
 * attempt: validate the queued handoff against the journal, resolve and record
 * an immutable source, materialize the Artifact, then append the terminal fact
 * directly with the exact stream-lifetime fence. It never calls Repo.
 */
export class RepoCreationCoordinatorDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!, { allowNullProjectId: true });
  readonly #stream = new StreamRpcTarget({
    auth: trustedInternalAuthContext(),
    path: this.#name.path,
    projectId: this.#name.projectId,
  });

  /** Report this incarnation's code version for the deployment rollout gate. */
  deploymentVersion(): string {
    return workerVersion(this.env);
  }

  /** Persist the exact obligation without pulling an existing retry forward. */
  async enqueue(input: RepoTemplateCreationHandoff): Promise<void> {
    const handoff = parseHandoff(input);
    const stored = this.ctx.storage.kv.get<unknown>(QUEUED_CREATION_STORAGE_KEY);
    if (stored === true) {
      // One-deploy migration from the initial coordinator, which stored only
      // a boolean. The next processor pass supplies the missing fenced input.
      this.ctx.storage.kv.put(QUEUED_CREATION_STORAGE_KEY, handoff);
      await this.ctx.storage.setAlarm(Date.now() + CREATION_HANDOFF_DELAY_MS);
      return;
    }
    if (stored !== undefined) {
      const existing = parseHandoff(stored);
      if (
        existing.streamId !== handoff.streamId ||
        existing.request.owner !== handoff.request.owner ||
        existing.request.repo !== handoff.request.repo ||
        existing.request.ref !== handoff.request.ref ||
        existing.request.path !== handoff.request.path
      ) {
        throw new Error("A different template-creation handoff is already queued for this repo.");
      }
      return;
    }

    this.ctx.storage.kv.put(QUEUED_CREATION_STORAGE_KEY, handoff);
    await this.ctx.storage.setAlarm(Date.now() + CREATION_HANDOFF_DELAY_MS);
  }

  async alarm(): Promise<void> {
    const stored = this.ctx.storage.kv.get<unknown>(QUEUED_CREATION_STORAGE_KEY);
    if (stored === undefined) return;

    try {
      const handoff =
        stored === true ? await this.#recoverOriginalBooleanHandoff() : parseHandoff(stored);
      await this.#drive(handoff);
      this.ctx.storage.kv.delete(QUEUED_CREATION_STORAGE_KEY);
    } catch (error) {
      if (isStreamIdMismatchError(error)) {
        // The path now names another event log. This saga has no authority to
        // touch it; its own processor will enqueue that lifetime's request.
        this.ctx.storage.kv.delete(QUEUED_CREATION_STORAGE_KEY);
        return;
      }
      // Native alarm retries are bounded. Preserve an explicit coarse wake-up
      // only for classified transient failures; an invariant violation stays
      // durably queued and visible in error telemetry without becoming an
      // unbounded explicit retry loop.
      if (isRetryableCreationAttemptError(error)) {
        await this.ctx.storage.setAlarm(Date.now() + CREATION_RETRY_DELAY_MS);
      }
      throw error;
    }
  }

  async #recoverOriginalBooleanHandoff(): Promise<RepoTemplateCreationHandoff> {
    const page = await this.#stream.getEventPage({
      eventTypes: ["events.iterate.com/repos/create-requested"],
    });
    const requestEvent = page.events.find(
      (event) => event.type === "events.iterate.com/repos/create-requested",
    );
    if (requestEvent === undefined) {
      throw new Error("The original queued template creation has no create-requested fact.");
    }
    const parsed = RepoProcessorContract.parseEvent(requestEvent);
    if (
      parsed.type !== "events.iterate.com/repos/create-requested" ||
      parsed.payload.type !== "github-public-template"
    ) {
      throw new Error("The original coordinator queue does not name a public-template request.");
    }
    const handoff = { request: parsed.payload, streamId: page.streamId };
    this.ctx.storage.kv.put(QUEUED_CREATION_STORAGE_KEY, handoff);
    return handoff;
  }

  async #drive(handoff: RepoTemplateCreationHandoff): Promise<void> {
    const page = await this.#stream.getEventPage({
      eventTypes: [
        "events.iterate.com/repos/create-requested",
        "events.iterate.com/repos/created",
        "events.iterate.com/repos/create-failed",
      ],
    });
    if (page.streamId !== handoff.streamId) {
      throw new Error(
        `stream ID changed (${handoff.streamId} -> ${page.streamId}); append rejected`,
      );
    }
    const requestEvent = page.events.find(
      (event) => event.type === "events.iterate.com/repos/create-requested",
    );
    if (requestEvent === undefined) {
      throw new Error("The queued template creation has no durable create-requested fact.");
    }
    const parsedRequest = RepoProcessorContract.parseEvent(requestEvent);
    if (
      parsedRequest.type !== "events.iterate.com/repos/create-requested" ||
      parsedRequest.payload.type !== "github-public-template" ||
      parsedRequest.payload.owner !== handoff.request.owner ||
      parsedRequest.payload.repo !== handoff.request.repo ||
      parsedRequest.payload.ref !== handoff.request.ref ||
      parsedRequest.payload.path !== handoff.request.path
    ) {
      throw new Error("The queued template creation does not match the stream's request fact.");
    }
    if (
      page.events.some(
        (event) =>
          event.type === "events.iterate.com/repos/created" ||
          event.type === "events.iterate.com/repos/create-failed",
      )
    ) {
      return;
    }

    let source = await this.#journaledSource(handoff.request);
    if (source === null) {
      try {
        source = await createGithubTemplateSource().resolve(handoff.request);
      } catch (error) {
        if (isRetryableGithubTemplateSourceError(error)) throw error;
        await this.#appendFailure(handoff, error);
        return;
      }
      await this.#append(handoff.streamId, {
        type: "events.iterate.com/repos/template-source-resolved",
        idempotencyKey: internalStreamId(
          "repo-template-source-resolved",
          this.#name.projectId,
          this.#name.path,
        ),
        payload: source,
      });
    }

    const artifact = await createGithubTemplateArtifact({
      artifactName: RepoArtifactNameCodec.stringify(this.#name),
      artifacts: this.env.ARTIFACTS,
      artifactsAccountId: this.env.ARTIFACTS_ACCOUNT_ID,
      artifactsNamespace: this.env.ARTIFACTS_NAMESPACE,
      projectId: this.#name.projectId,
      repoPath: this.#name.path,
      source,
    }).catch(async (error: unknown) => {
      if (isRetryableCreationAttemptError(error)) {
        throw error;
      }
      await this.#appendFailure(handoff, error);
      return null;
    });
    if (artifact === null) return;

    await this.#append(handoff.streamId, {
      type: "events.iterate.com/repos/created",
      idempotencyKey: `${RepoProcessorContract.slug}/created`,
      payload: { ...artifact, request: handoff.request },
    });
  }

  async #journaledSource(
    request: RepoTemplateCreationHandoff["request"],
  ): Promise<NonNullable<RepoProcessorState["templateSource"]> | null> {
    const event = await this.#stream.getEvent({
      idempotencyKey: internalStreamId(
        "repo-template-source-resolved",
        this.#name.projectId,
        this.#name.path,
      ),
    });
    if (event === undefined) return null;
    const parsed = RepoProcessorContract.parseEvent(event);
    if (
      parsed.type !== "events.iterate.com/repos/template-source-resolved" ||
      parsed.payload.owner !== request.owner ||
      parsed.payload.repo !== request.repo ||
      parsed.payload.ref !== request.ref ||
      parsed.payload.path !== request.path
    ) {
      throw new Error("The journaled GitHub template source does not match its creation request.");
    }
    return parsed.payload;
  }

  async #appendFailure(handoff: RepoTemplateCreationHandoff, error: unknown): Promise<void> {
    await this.#append(handoff.streamId, {
      type: "events.iterate.com/repos/create-failed",
      idempotencyKey: `${RepoProcessorContract.slug}/create-failed`,
      payload: {
        error: error instanceof Error ? error.message : String(error),
        request: handoff.request,
      },
    });
  }

  async #append(streamId: string, event: Parameters<StreamRpcTarget["append"]>[0]): Promise<void> {
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
