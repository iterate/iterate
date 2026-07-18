import type { StreamEventInput } from "iterate/processors";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { RepoArtifactNameCodec } from "../repos/utils.ts";
import { workerEventsQueueName } from "../../queue-names.ts";
import {
  createCloudflareAccountApi,
  desiredArtifactRepoEventSubscription,
  ensureArtifactEventSubscription,
  listArtifactEventSubscriptions,
  queueIdForWorkerEventQueue,
} from "./cloudflare-event-subscriptions.ts";

export const GLOBAL_CLOUDFLARE_EVENTS_STREAM_PATH = "/cloudflare/events";
export const CLOUDFLARE_EVENT_RECEIVED_TYPE = "events.iterate.com/cloudflare/event-received";
export const REPO_CLOUDFLARE_ARTIFACT_EVENT_RECEIVED_TYPE =
  "events.iterate.com/repo/cloudflare-artifact-event-received";

// Event delivery is authoritative; Cloudflare subscription provisioning is a
// bounded control-plane follow-up. Keep enough concurrency to drain repo
// creation bursts without turning one Queue batch into ten serial API waits.
const SUBSCRIPTION_ENSURE_CONCURRENCY = 2;
const SUBSCRIPTION_API_TIMEOUT_MS = 5_000;

type EventQueueEnv = Pick<
  Env,
  "ARTIFACTS_ACCOUNT_ID" | "ARTIFACTS_NAMESPACE" | "STREAM" | "WORKER_SELF"
> & {
  APP_CONFIG_CLOUDFLARE__API_TOKEN?: string;
};

export function isWorkerEventsQueue(queue: string, env: Pick<Env, "WORKER_SELF">): boolean {
  return queue === workerEventsQueueName(env.WORKER_SELF);
}

export async function handleEventQueueBatch(
  batch: MessageBatch,
  env: EventQueueEnv,
): Promise<void> {
  if (!isWorkerEventsQueue(batch.queue, env)) {
    console.warn(`[event-queue] received batch from unexpected queue ${batch.queue}`);
  }

  // Finish the authoritative stream fanout for the whole batch before making
  // any account-level control-plane calls. Repo streams are independent, so
  // fan them out concurrently instead of making the tenth project wait for
  // nine unrelated Durable Objects.
  const fanoutResults = await Promise.all(
    batch.messages.map(async (message): Promise<RepoFanoutResult | null> => {
      const cloudflareEvent = cloudflareEventFromMessageBody(message.body);
      if (cloudflareEvent === null) {
        console.warn(`[event-queue] ignoring unrecognized message ${message.id}`);
        message.ack();
        return null;
      }

      try {
        const repoNameToSubscribe = await appendRepoArtifactEventIfAddressable({
          env,
          message,
          event: cloudflareEvent,
        });
        return { message, repoNameToSubscribe };
      } catch (error) {
        console.error(`[event-queue] failed to fan out message ${message.id}`, error);
        message.retry();
        return null;
      }
    }),
  );
  const successfulFanouts = fanoutResults.filter(
    (result): result is RepoFanoutResult => result !== null,
  );
  if (successfulFanouts.length === 0) return;

  // One append preserves per-message idempotency while avoiding ten serial
  // round trips to the deployment-global capture stream.
  try {
    await appendCloudflareCaptures({
      env,
      messages: successfulFanouts.map((result) => result.message),
    });
  } catch (error) {
    console.error(
      `[event-queue] failed to globally capture ${successfulFanouts.length} messages`,
      error,
    );
    for (const { message } of successfulFanouts) message.retry();
    return;
  }

  const repoNamesToSubscribe = new Set(
    successfulFanouts.flatMap((result) =>
      result.repoNameToSubscribe === null ? [] : [result.repoNameToSubscribe],
    ),
  );
  await ensureRepoEventSubscriptionsIfConfigured({
    env,
    repoNames: [...repoNamesToSubscribe],
  });

  // Provisioning failures are bounded and logged inside the helper. Preserve
  // the previous best-effort semantics, but acknowledge only after the attempt
  // so an interrupted invocation retries its idempotent stream appends.
  for (const { message } of successfulFanouts) message.ack();
}

type RepoFanoutResult = {
  message: Message;
  repoNameToSubscribe: string | null;
};

function cloudflareEventFromMessageBody(body: unknown): Record<string, unknown> | null {
  const event = asRecord(body);
  if (event === null) return null;
  if (typeof event.type !== "string" || !event.type.startsWith("cf.")) return null;
  const source = asRecord(event.source);
  if (source === null || typeof source.type !== "string") return null;
  return event;
}

async function appendCloudflareCaptures(input: {
  env: EventQueueEnv;
  messages: Message[];
}): Promise<void> {
  await appendToStream(
    input.env,
    { projectId: null, path: GLOBAL_CLOUDFLARE_EVENTS_STREAM_PATH },
    ...input.messages.map((message) => ({
      type: CLOUDFLARE_EVENT_RECEIVED_TYPE,
      idempotencyKey: `cf-event:${message.id}`,
      payload: { body: message.body },
    })),
  );
}

async function appendRepoArtifactEventIfAddressable(input: {
  env: EventQueueEnv;
  event: Record<string, unknown>;
  message: Message;
}): Promise<string | null> {
  const artifactRepo = artifactRepoReferenceFromCloudflareEvent(input.event);
  if (artifactRepo === null) return null;
  if (artifactRepo.namespace !== input.env.ARTIFACTS_NAMESPACE) return null;

  let streamAddress: { projectId: string | null; path: string };
  try {
    streamAddress = RepoArtifactNameCodec.parse(artifactRepo.repoName);
  } catch (error) {
    console.warn(
      `[event-queue] artifact repo name is not addressable: ${artifactRepo.repoName}`,
      error,
    );
    return null;
  }

  const payload: Record<string, unknown> = {
    artifactName: artifactRepo.repoName,
    body: input.message.body,
    namespace: artifactRepo.namespace,
  };
  const cloudflareEventType = typeof input.event.type === "string" ? input.event.type : undefined;
  if (cloudflareEventType !== undefined) payload.cloudflareEventType = cloudflareEventType;

  await appendToStream(input.env, streamAddress, {
    type: REPO_CLOUDFLARE_ARTIFACT_EVENT_RECEIVED_TYPE,
    idempotencyKey: `cf-artifact-event:${input.message.id}`,
    payload,
  });

  return cloudflareEventType !== undefined && shouldEnsureRepoEventSubscription(cloudflareEventType)
    ? artifactRepo.repoName
    : null;
}

function shouldEnsureRepoEventSubscription(cloudflareEventType: string): boolean {
  return [
    "cf.artifacts.repo.created",
    "cf.artifacts.repo.forked",
    "cf.artifacts.repo.imported",
  ].includes(cloudflareEventType);
}

async function ensureRepoEventSubscriptionsIfConfigured(input: {
  env: EventQueueEnv;
  repoNames: string[];
}): Promise<void> {
  if (input.repoNames.length === 0) return;

  const apiToken = input.env.APP_CONFIG_CLOUDFLARE__API_TOKEN?.trim();
  if (!apiToken) {
    console.warn("[event-queue] Cloudflare API token unavailable; cannot subscribe repo events", {
      repoCount: input.repoNames.length,
    });
    return;
  }

  const api = createCloudflareAccountApi({
    accountId: input.env.ARTIFACTS_ACCOUNT_ID,
    apiToken,
    requestTimeoutMs: SUBSCRIPTION_API_TIMEOUT_MS,
  });

  let queueId: string;
  let existing: Awaited<ReturnType<typeof listArtifactEventSubscriptions>>;
  try {
    [queueId, existing] = await Promise.all([
      queueIdForWorkerEventQueue(api, input.env.WORKER_SELF),
      listArtifactEventSubscriptions(api),
    ]);
  } catch (error) {
    console.warn("[event-queue] failed to load artifact subscription state", {
      error,
      repoCount: input.repoNames.length,
    });
    return;
  }

  for (let offset = 0; offset < input.repoNames.length; offset += SUBSCRIPTION_ENSURE_CONCURRENCY) {
    const repoNames = input.repoNames.slice(offset, offset + SUBSCRIPTION_ENSURE_CONCURRENCY);
    await Promise.all(
      repoNames.map(async (repoName) => {
        try {
          const desired = await desiredArtifactRepoEventSubscription({
            repoName,
            workerName: input.env.WORKER_SELF,
          });
          const result = await ensureArtifactEventSubscription(api, { desired, existing, queueId });
          if (result !== "unchanged") {
            console.log(`[event-queue] artifact repo subscription ${desired.name} ${result}`);
          }
        } catch (error) {
          console.warn("[event-queue] failed to ensure artifact repo subscription", {
            error,
            repoName,
          });
        }
      }),
    );
  }
}

function artifactRepoReferenceFromCloudflareEvent(
  event: Record<string, unknown>,
): { namespace: string; repoName: string } | null {
  const eventType = typeof event.type === "string" ? event.type : undefined;
  const payload = asRecord(event.payload);
  if (eventType === "cf.artifacts.repo.forked") {
    if (payload === null) return null;
    const targetNamespace = readString(payload.namespace);
    const targetRepoName = readString(payload.repoName) ?? readString(payload.repo_name);
    if (targetNamespace !== null && targetRepoName !== null) {
      return { namespace: targetNamespace, repoName: targetRepoName };
    }
    return null;
  }

  const source = asRecord(event.source);
  if (source === null) return null;
  const sourceType = readString(source.type);
  if (sourceType !== "artifacts" && sourceType !== "artifacts.repo") return null;

  const namespace = readString(source.namespace);
  const repoName = readString(source.repoName) ?? readString(source.repo_name);
  if (namespace === null || repoName === null) return null;
  return { namespace, repoName };
}

function appendToStream(
  env: Pick<Env, "STREAM">,
  address: { projectId: string | null; path: string },
  ...events: StreamEventInput[]
) {
  return env.STREAM.getByName(
    DurableObjectNameCodec.stringify(address, { allowNullProjectId: true }),
  ).append(...events);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
