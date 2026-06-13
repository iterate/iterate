/**
 * Repo worker: artifact-backed git repos. Also consumes the artifact-events
 * queue (verbatim Cloudflare Artifacts event capture onto repo streams) —
 * the queue is repo-domain, so its consumer lives here, not in the app.
 */
import { handleArtifactEventsBatch } from "~/domains/repos/artifact-events-queue-handler.ts";

export { RepoDurableObject } from "~/domains/repos/durable-objects/repo-durable-object.ts";

export default {
  fetch: () => Response.json({ worker: "os-repo" }, { status: 404 }),

  async queue(batch: MessageBatch, env: Env) {
    if (batch.queue.endsWith("-artifact-events")) {
      await handleArtifactEventsBatch(batch, env);
      return;
    }
    console.warn("[os-repo] received unhandled queue batch", {
      messageCount: batch.messages.length,
      queue: batch.queue,
    });
  },
};
