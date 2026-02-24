import { logger } from "../tag-logger.ts";
import { createPgmqQueuer } from "./pgmq-lib.ts";

/** low-level queuer for our outbox. No types here, since types are partially inferred from our oRPC router definitions */
export const queuer = createPgmqQueuer({ queueName: "consumer_job_queue" });

queuer.on("statusChange", async () => {
  try {
    const { broadcastInvalidation } = await import("../utils/query-invalidation.ts");
    const { env } = await import("../../env.ts");
    await broadcastInvalidation(env);
  } catch (e) {
    logger.error("[outbox] broadcastInvalidation failed in statusChange listener", e);
  }
});

queuer.on("statusChange", async (event) => {
  if (event.error && event.retry?.retry) {
    const { job, error, retry } = event;

    logger.warn(
      `[outbox] Consumer ${job.message.consumer_name} retrying in ${retry.delay} after ${job.read_ct} attempts. Error: ${String(error)}`,
      Object.assign(error, { detail: { job, retry } }),
    );
  }
  if (event.error && !event.retry?.retry) {
    const { job, error, retry } = event;
    logger.error(
      `[outbox] Consumer ${job.message.consumer_name} failed after ${job.read_ct} attempts. Error: ${String(error)}`,
      Object.assign(error, { detail: { job, retry } }),
    );
  } else if (event.error) {
  }
});
