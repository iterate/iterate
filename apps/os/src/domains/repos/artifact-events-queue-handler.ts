import { StreamPath } from "@iterate-com/shared/streams/types";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "~/domains/streams/new-stream-runtime.ts";

/**
 * Consume Cloudflare event-subscription messages (currently Artifacts repo
 * lifecycle events) and capture each one verbatim to the worker-global
 * `/cloudflare/events` stream.
 *
 * This handler deliberately does not interpret or fan out events: routing
 * pushes/clones to per-repo project streams is the job of a stream processor
 * on the capture stream, mirroring how Slack webhooks are captured as
 * `events.iterate.com/slack/webhook-received` and routed by the Slack
 * processor.
 *
 * Event shapes: https://developers.cloudflare.com/queues/event-subscriptions/events-schemas/
 */
const GLOBAL_CF_EVENTS_STREAM_PATH = StreamPath.parse("/cloudflare/events");

export type ArtifactEventsQueueEnv = {
  GLOBAL_STREAM_NAMESPACE: string;
  STREAM: StreamDurableObjectNamespace;
};

export async function handleArtifactEventsBatch(
  batch: MessageBatch,
  env: ArtifactEventsQueueEnv,
): Promise<void> {
  const stream = await getInitializedStreamStub({
    durableObjectNamespace: env.STREAM,
    namespace: env.GLOBAL_STREAM_NAMESPACE,
    path: GLOBAL_CF_EVENTS_STREAM_PATH,
  });

  for (const message of batch.messages) {
    try {
      await stream.append({
        type: "events.iterate.com/cloudflare/event-received",
        // Queue message ids are stable across retries, so redelivered
        // messages dedupe instead of appending twice.
        idempotencyKey: `cf-event:${message.id}`,
        payload: { body: message.body },
      });
      message.ack();
    } catch (error) {
      console.error("[artifact-events] failed to capture message", message.id, error);
      message.retry();
    }
  }
}
