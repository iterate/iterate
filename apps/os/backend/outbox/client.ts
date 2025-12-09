import type { appRouter } from "../trpc/root.ts";
import { type TrpcEventTypes, createConsumerClient } from "./pgmq-lib.ts";
import { queuer } from "./outbox-queuer.ts";

export type InternalEventTypes = {
  "onboarding:estateCreated": { estateId: string };
  "testing:poke": { message: string };
};

type AppTrpcEventTypes = TrpcEventTypes<typeof appRouter>;

export const outboxClient = createConsumerClient<
  InternalEventTypes & AppTrpcEventTypes,
  typeof queuer.$types.db
>(queuer);
