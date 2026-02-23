import { randomUUID } from "node:crypto";
import { eventSchema, eventsContract } from "@jonasland2/events-contract";
import { ORPCError, implement, type InferSchemaOutput } from "@orpc/server";
import { withSpan } from "./otel-init.ts";

type EventRecord = InferSchemaOutput<typeof eventSchema>;

const serviceName = "jonasland2-events-service";
const os = implement(eventsContract);

const events: EventRecord[] = [];

const listEvents = os.events.list.handler(async ({ input }) => {
  return withSpan(serviceName, "events.list", { "events.limit": input.limit }, async () => {
    return {
      events: events.slice(0, input.limit),
      total: events.length,
    };
  });
});

const createEvent = os.events.create.handler(async ({ input }) => {
  return withSpan(serviceName, "events.create", { "event.type": input.type }, async () => {
    const event: EventRecord = {
      id: randomUUID(),
      type: input.type,
      payload: input.payload,
      createdAt: new Date().toISOString(),
    };

    events.unshift(event);
    if (events.length > 500) events.length = 500;
    return event;
  });
});

const findEvent = os.events.find.handler(async ({ input }) => {
  return withSpan(serviceName, "events.find", { "event.id": input.id }, async () => {
    const event = events.find((item) => item.id === input.id);
    if (!event) {
      throw new ORPCError("NOT_FOUND", {
        message: `Event ${input.id} not found`,
      });
    }

    return event;
  });
});

export const eventsRouter = os.router({
  events: {
    list: listEvents,
    create: createEvent,
    find: findEvent,
  },
});
