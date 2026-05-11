import { logger } from "../tag-logger.ts";
import { createPgmqQueuer } from "./pgmq-lib.ts";
import { createOutboxJobLifecycleHook, sendDLQToPostHog } from "./outbox-logging.ts";

/** low-level queuer for our outbox. No types here, since types are partially inferred from our oRPC router definitions */
export const queuer = createPgmqQueuer({
  queueName: "consumer_job_queue",
  onJob: createOutboxJobLifecycleHook(),
});

queuer.on("statusChange", async () => {
  try {
    const { broadcastInvalidation } = await import("../utils/query-invalidation.ts");
    const { env } = await import("../../env.ts");
    await broadcastInvalidation(env);
  } catch (e) {
    logger.error("[outbox] broadcastInvalidation failed in statusChange listener", e);
  }
});

queuer.on("statusChange", sendDLQToPostHog);
