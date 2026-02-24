import { oc } from "@orpc/contract";
import { createServiceSubRouterContract } from "@jonasland2/shared";
import { z } from "zod/v4";
import packageJson from "../package.json" with { type: "json" };

export const eventSchema = z.object({
  id: z.string(),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const createEventInputSchema = z.object({
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional().default({}),
});

export const listEventsInputSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const serviceSubRouter = createServiceSubRouterContract({
  healthSummary: "Events service health metadata",
  sqlSummary: "Execute SQL against events-service sqlite database",
});

export const eventsContract = oc.router({
  ...serviceSubRouter,
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

    update: oc
      .route({
        method: "PATCH",
        path: "/events/{id}",
        summary: "Update an event by id",
        tags: ["events"],
      })
      .input(
        z
          .object({
            id: z.string(),
            type: z.string().min(1).optional(),
            payload: z.record(z.string(), z.unknown()).optional(),
          })
          .refine((input) => input.type !== undefined || input.payload !== undefined, {
            message: "At least one field must be provided",
          }),
      )
      .output(eventSchema),

    remove: oc
      .route({
        method: "DELETE",
        path: "/events/{id}",
        summary: "Delete an event by id",
        tags: ["events"],
      })
      .input(
        z.object({
          id: z.string(),
        }),
      )
      .output(
        z.object({
          ok: z.literal(true),
          id: z.string(),
          deleted: z.boolean(),
        }),
      ),
  },
});

const nonEmptyStringWithTrimDefault = (defaultValue: string) =>
  z
    .preprocess((value) => {
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      return trimmed.length === 0 ? undefined : trimmed;
    }, z.string().min(1).optional())
    .default(defaultValue);

export const eventsServiceEnvSchema = z.object({
  EVENTS_SERVICE_PORT: z.coerce.number().int().min(1).max(65535).default(19010),
  EVENTS_DB_PATH: nonEmptyStringWithTrimDefault("/var/lib/jonasland2/events-service.sqlite"),
});
export type EventsServiceEnv = z.infer<typeof eventsServiceEnvSchema>;

export const eventsServiceManifest = {
  name: packageJson.name,
  slug: "events-service",
  version: packageJson.version ?? "0.0.0",
  port: 19010,
  orpcContract: eventsContract,
  envVars: eventsServiceEnvSchema,
} as const;
