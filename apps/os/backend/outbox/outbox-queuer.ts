import { createPgmqQueuer } from "./pgmq-lib.ts";

/** low-level queuer for our outbox. No types here, since types are partially inferred from our trpc router definitions */
export const queuer = createPgmqQueuer({ queueName: "consumer_job_queue" });
