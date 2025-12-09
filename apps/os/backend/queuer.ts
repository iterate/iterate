import { createPgmqQueuer } from "./db/outbox/events.ts";

export const queuer = createPgmqQueuer({ queueName: "consumer_job_queue" });
