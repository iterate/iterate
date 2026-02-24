import { randomUUID } from "node:crypto";
import { eventSchema, eventsContract } from "@jonasland2/events-contract";
import {
  createRequestContextMiddleware,
  createRequestLifecycleMiddleware,
  createServiceLogger,
  type SharedRequestContext,
} from "@jonasland2/orpc-shared";
import { ORPCError, implement, type InferSchemaOutput } from "@orpc/server";

type EventRecord = InferSchemaOutput<typeof eventSchema>;
type EventsContext = SharedRequestContext;

const serviceName = "jonasland2-events-service";
const log = createServiceLogger(serviceName);
const os = implement(eventsContract).$context<EventsContext>();

const withSharedMiddlewares = os
  .use(os.middleware(createRequestContextMiddleware(serviceName, log)))
  .use(os.middleware(createRequestLifecycleMiddleware(serviceName, log)));

const events: EventRecord[] = [];

const listEvents = withSharedMiddlewares.events.list.handler(async ({ input, context }) => {
  log("events.list", {
    request_id: context.requestId,
    limit: input.limit,
    total: events.length,
  });

  return {
    events: events.slice(0, input.limit),
    total: events.length,
  };
});

const createEvent = withSharedMiddlewares.events.create.handler(async ({ input, context }) => {
  const event: EventRecord = {
    id: randomUUID(),
    type: input.type,
    payload: input.payload,
    createdAt: new Date().toISOString(),
  };

  events.unshift(event);
  if (events.length > 500) events.length = 500;

  log("events.created", {
    request_id: context.requestId,
    event_id: event.id,
    event_type: event.type,
  });

  return event;
});

const findEvent = withSharedMiddlewares.events.find.handler(async ({ input, context }) => {
  const event = events.find((item) => item.id === input.id);
  if (!event) {
    throw new ORPCError("NOT_FOUND", {
      message: `Event ${input.id} not found`,
    });
  }

  log("events.found", {
    request_id: context.requestId,
    event_id: event.id,
  });

  return event;
});

export const eventsRouter = withSharedMiddlewares.router({
  events: {
    list: listEvents,
    create: createEvent,
    find: findEvent,
  },
});
