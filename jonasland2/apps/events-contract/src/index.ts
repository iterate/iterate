import { oc } from "@orpc/contract";
import { z } from "zod/v4";

export const eventSchema = z.object({
  id: z.string(),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

export const createEventInputSchema = z.object({
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional().default({}),
});

export const listEventsInputSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export const eventsContract = oc.router({
  events: {
    list: oc
      .route({
        method: "GET",
        path: "/events",
        summary: "List recent events",
        tags: ["events"],
      })
      .input(listEventsInputSchema)
      .output(
        z.object({
          events: z.array(eventSchema),
          total: z.number().int().nonnegative(),
        }),
      ),

    create: oc
      .route({
        method: "POST",
        path: "/events",
        summary: "Create an event",
        tags: ["events"],
      })
      .input(createEventInputSchema)
      .output(eventSchema),

    find: oc
      .route({
        method: "GET",
        path: "/events/{id}",
        summary: "Get event by id",
        tags: ["events"],
      })
      .input(
        z.object({
          id: z.string(),
        }),
      )
      .output(eventSchema),
  },
});
