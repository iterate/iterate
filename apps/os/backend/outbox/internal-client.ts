import { waitUntil } from "../../env.ts";
import { createConsumerClient } from "./pgmq-lib.ts";
import { queuer } from "./outbox-queuer.ts";
import type { InternalEventTypes } from "./event-types.ts";

export const internalOutboxClient = createConsumerClient<
  InternalEventTypes,
  typeof queuer.$types.db
>(queuer, { waitUntil });
