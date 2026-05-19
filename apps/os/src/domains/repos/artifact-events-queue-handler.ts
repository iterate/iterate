import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
  type StreamDurableObject,
} from "~/domains/streams/new-stream-runtime.ts";
import { StreamPath } from "@iterate-com/shared/streams/types";
import {
  ACCOUNT_LEVEL_CF_TYPES,
  CF_EVENT_RECEIVED_TYPE,
  CF_TO_GLOBAL_REPOS_TYPE,
  CF_TO_REPO_STREAM_TYPE,
  CfArtifactEvent,
  REPO_LEVEL_CF_TYPES,
  deriveArtifactNameFromEvent,
  parseArtifactName,
} from "~/domains/repos/artifact-event-types.ts";
import { repoStreamPath } from "~/domains/repos/stream-processors/repo-stream-processor.ts";

// ---------------------------------------------------------------------------
// Stream paths & namespaces
// ---------------------------------------------------------------------------

const GLOBAL_CF_EVENTS_STREAM_PATH = StreamPath.parse("/cloudflare/events");
const GLOBAL_REPOS_STREAM_PATH = StreamPath.parse("/repos");

export type ArtifactEventsQueueEnv = {
  ARTIFACTS_NAMESPACE?: string;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
};

/**
 * Derive the global namespace name for non-project-scoped streams.
 *
 * Uses the artifacts namespace (which follows `{workerName}-repos`) and
 * replaces the `-repos` suffix with `-global`. Falls back to `os-global`.
 */
function globalNamespace(env: ArtifactEventsQueueEnv): string {
  const ns = env.ARTIFACTS_NAMESPACE;
  if (ns && ns.endsWith("-repos")) {
    return ns.replace(/-repos$/, "-global");
  }
  return ns ? `${ns}-global` : "os-global";
}

// ---------------------------------------------------------------------------
// Queue handler
// ---------------------------------------------------------------------------

export async function handleArtifactEventsBatch(
  batch: MessageBatch,
  env: ArtifactEventsQueueEnv,
): Promise<void> {
  const stream = env.STREAM as unknown as StreamDurableObjectNamespace;
  const globalNs = globalNamespace(env);

  for (const message of batch.messages) {
    try {
      const parsed = CfArtifactEvent.safeParse(message.body);
      if (!parsed.success) {
        console.error(
          "[artifact-events] Failed to parse CF event",
          parsed.error.issues,
          message.body,
        );
        message.ack();
        continue;
      }

      const cfEvent = parsed.data;
      const messageId = message.id;

      // 1. Append raw event to global cloudflare events stream
      const globalCfEventsStub = await getInitializedStreamStub({
        durableObjectNamespace: stream,
        namespace: globalNs,
        path: GLOBAL_CF_EVENTS_STREAM_PATH,
      });

      await globalCfEventsStub.append({
        type: CF_EVENT_RECEIVED_TYPE,
        idempotencyKey: `cf-event:${messageId}`,
        payload: {
          cfType: cfEvent.type,
          source: cfEvent.source ?? {},
          payload: cfEvent.payload,
        },
        metadata: cfEvent.metadata ? { cloudflare: cfEvent.metadata } : undefined,
      });

      // 2. Fan-out to target streams
      // TODO: fan-out should be a separate stream processor
      await fanOutEvent({ cfEvent, env, globalNs, messageId, stream });

      message.ack();
    } catch (error) {
      console.error("[artifact-events] Error processing message", message.id, error);
      message.retry();
    }
  }
}

// ---------------------------------------------------------------------------
// Fan-out logic
// ---------------------------------------------------------------------------

async function fanOutEvent(args: {
  cfEvent: CfArtifactEvent;
  env: ArtifactEventsQueueEnv;
  globalNs: string;
  messageId: string;
  stream: StreamDurableObjectNamespace;
}): Promise<void> {
  const { cfEvent, globalNs, messageId, stream } = args;

  if (REPO_LEVEL_CF_TYPES.has(cfEvent.type)) {
    await fanOutRepoLevelEvent({ cfEvent, messageId, stream });
  }

  if (ACCOUNT_LEVEL_CF_TYPES.has(cfEvent.type)) {
    await fanOutAccountLevelEvent({ cfEvent, globalNs, messageId, stream });
  }
}

async function fanOutRepoLevelEvent(args: {
  cfEvent: CfArtifactEvent;
  messageId: string;
  stream: StreamDurableObjectNamespace;
}): Promise<void> {
  const { cfEvent, messageId, stream } = args;

  const artifactName = deriveArtifactNameFromEvent(cfEvent);
  if (!artifactName) {
    console.warn("[artifact-events] Repo-level event missing artifact name", cfEvent.type);
    return;
  }

  const parsed = parseArtifactName(artifactName);
  if (!parsed) {
    console.warn("[artifact-events] Could not parse artifact name", artifactName);
    return;
  }

  const eventType = CF_TO_REPO_STREAM_TYPE[cfEvent.type];
  if (!eventType) return;

  const stub = await getInitializedStreamStub({
    durableObjectNamespace: stream,
    namespace: parsed.projectId,
    path: repoStreamPath(parsed.repoSlug),
  });

  await stub.append({
    type: eventType,
    idempotencyKey: `cf-event-fanout:${messageId}`,
    payload: buildRepoLevelPayload(cfEvent),
  });
}

async function fanOutAccountLevelEvent(args: {
  cfEvent: CfArtifactEvent;
  globalNs: string;
  messageId: string;
  stream: StreamDurableObjectNamespace;
}): Promise<void> {
  const { cfEvent, globalNs, messageId, stream } = args;

  const eventType = CF_TO_GLOBAL_REPOS_TYPE[cfEvent.type];
  if (!eventType) return;

  const artifactName = deriveArtifactNameFromEvent(cfEvent);
  const parsed = artifactName ? parseArtifactName(artifactName) : null;

  const stub = await getInitializedStreamStub({
    durableObjectNamespace: stream,
    namespace: globalNs,
    path: GLOBAL_REPOS_STREAM_PATH,
  });

  await stub.append({
    type: eventType,
    idempotencyKey: `cf-event-fanout:${messageId}`,
    payload: {
      artifactName: artifactName ?? "unknown",
      projectId: parsed?.projectId ?? null,
      repoSlug: parsed?.repoSlug ?? null,
      cfPayload: cfEvent.payload,
    },
  });
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

function buildRepoLevelPayload(cfEvent: CfArtifactEvent): Record<string, unknown> {
  const raw = cfEvent.payload;

  if (cfEvent.type === "cf.artifacts.pushed") {
    return {
      ref: raw.ref ?? "",
      before: raw.before ?? "",
      after: raw.after ?? "",
      commits: Array.isArray(raw.commits)
        ? (raw.commits as Array<Record<string, unknown>>).map((c) => ({
            id: c.id ?? "",
            message: c.message ?? "",
            timestamp: c.timestamp ?? "",
            author: c.author ?? { name: "", email: "" },
            committer: c.committer ?? { name: "", email: "" },
          }))
        : [],
      totalCommits: raw.totalCommitsCount ?? 0,
      cfPayload: raw,
    };
  }

  // cloned / fetched — minimal payload
  return { cfPayload: raw };
}
