import type { Env } from "../../env.ts";
import type { StreamEventInput } from "../../types.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { RepoArtifactNameCodec } from "../repos/utils.ts";
import { workerEventsQueueName } from "../../queue-names.ts";

export const GLOBAL_CLOUDFLARE_EVENTS_STREAM_PATH = "/cloudflare/events";
export const CLOUDFLARE_EVENT_RECEIVED_TYPE = "events.iterate.com/cloudflare/event-received";
export const REPO_CLOUDFLARE_ARTIFACT_EVENT_RECEIVED_TYPE =
  "events.iterate.com/repo/cloudflare-artifact-event-received";

type EventQueueEnv = Pick<Env, "ARTIFACTS_NAMESPACE" | "STREAM" | "WORKER_SELF">;

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

  for (const message of batch.messages) {
    try {
      const cloudflareEvent = cloudflareEventFromMessageBody(message.body);
      if (cloudflareEvent === null) {
        console.warn(`[event-queue] ignoring unrecognized message ${message.id}`);
        message.ack();
        continue;
      }

      await appendRepoArtifactEventIfAddressable({ env, message, event: cloudflareEvent });
      await appendCloudflareCapture({ env, message });
      message.ack();
    } catch (error) {
      console.error(`[event-queue] failed to process message ${message.id}`, error);
      message.retry();
    }
  }
}

function cloudflareEventFromMessageBody(body: unknown): Record<string, unknown> | null {
  const event = asRecord(body);
  if (event === null) return null;
  if (typeof event.type !== "string" || !event.type.startsWith("cf.")) return null;
  const source = asRecord(event.source);
  if (source === null || typeof source.type !== "string") return null;
  return event;
}

async function appendCloudflareCapture(input: {
  env: EventQueueEnv;
  message: Message;
}): Promise<void> {
  await appendToStream(
    input.env,
    { projectId: null, path: GLOBAL_CLOUDFLARE_EVENTS_STREAM_PATH },
    {
      type: CLOUDFLARE_EVENT_RECEIVED_TYPE,
      idempotencyKey: `cf-event:${input.message.id}`,
      payload: { body: input.message.body },
    },
  );
}

async function appendRepoArtifactEventIfAddressable(input: {
  env: EventQueueEnv;
  event: Record<string, unknown>;
  message: Message;
}): Promise<void> {
  const artifactRepo = artifactRepoReferenceFromCloudflareEvent(input.event);
  if (artifactRepo === null) return;
  if (artifactRepo.namespace !== input.env.ARTIFACTS_NAMESPACE) return;

  let streamAddress: { projectId: string | null; path: string };
  try {
    streamAddress = RepoArtifactNameCodec.parse(artifactRepo.repoName);
  } catch (error) {
    console.warn(
      `[event-queue] artifact repo name is not addressable: ${artifactRepo.repoName}`,
      error,
    );
    return;
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
  event: StreamEventInput,
) {
  return env.STREAM.getByName(
    DurableObjectNameCodec.stringify(address, { allowNullProjectId: true }),
  ).append(event);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
