import { oc } from "@orpc/contract";
import { createServiceSubRouterContract } from "@iterate-com/shared/jonasland/service-contract";
import type { ServiceManifestWithEntryPoint } from "@iterate-com/shared/jonasland/service-contract";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };

export const Thing = z.object({
  id: z.string(),
  thing: z.string().min(1),
  eventId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const CreateThingInput = z.object({
  thing: z.string().min(1),
});

export const ListThingsInput = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export const UpdateThingInput = z
  .object({
    id: z.string(),
    thing: z.string().min(1).optional(),
  })
  .refine((input) => input.thing !== undefined, {
    message: "At least one field must be provided",
  });

export const DelayedPublishInput = z.object({
  streamPath: z.string().min(1).optional().default("/example/things"),
  type: z
    .string()
    .min(1)
    .regex(/^https:\/\/events\.iterate\.com\//, "type must start with https://events.iterate.com/"),
  payload: z.record(z.string(), z.unknown()).optional().default({}),
  delayMs: z.coerce.number().int().min(1).max(60_000).optional().default(1_000),
});

export const DelayedPublishOutput = z.object({
  accepted: z.literal(true),
  scheduledAt: z.string(),
  dueAt: z.string(),
  streamPath: z.string(),
  type: z.string(),
  delayMs: z.number().int().min(1),
});

export const EchoOutput = z.object({
  method: z.string(),
  url: z.string(),
  host: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
});

const serviceSubRouter = createServiceSubRouterContract({
  healthSummary: "Example service health metadata",
  sqlSummary: "Execute SQL against example sqlite database",
});

export const exampleContract = oc.router({
  ...serviceSubRouter,
  echo: oc
    .route({
      method: "GET",
      path: "/echo",
      summary: "Echo request metadata",
      tags: ["debug"],
    })
    .input(z.object({}).optional().default({}))
    .output(EchoOutput),
  things: {
    create: oc
      .route({
        method: "POST",
        path: "/things",
        summary: "Create a thing and emit an event",
        tags: ["things"],
      })
      .input(CreateThingInput)
      .output(Thing),

    list: oc
      .route({
        method: "GET",
        path: "/things",
        summary: "List things",
        tags: ["things"],
      })
      .input(ListThingsInput)
      .output(
        z.object({
          things: z.array(Thing),
          total: z.number().int().nonnegative(),
        }),
      ),

    find: oc
      .route({
        method: "GET",
        path: "/things/{id}",
        summary: "Get thing by id",
        tags: ["things"],
      })
      .input(z.object({ id: z.string() }))
      .output(Thing),

    update: oc
      .route({
        method: "PATCH",
        path: "/things/{id}",
        summary: "Update thing by id",
        tags: ["things"],
      })
      .input(UpdateThingInput)
      .output(Thing),

    remove: oc
      .route({
        method: "DELETE",
        path: "/things/{id}",
        summary: "Delete thing by id",
        tags: ["things"],
      })
      .input(z.object({ id: z.string() }))
      .output(
        z.object({
          ok: z.literal(true),
          id: z.string(),
          deleted: z.boolean(),
        }),
      ),

    ping: oc
      .route({
        method: "GET",
        path: "/things/ping",
        summary: "Simple health-style ping",
        tags: ["things"],
      })
      .input(z.object({}).optional().default({}))
      .output(
        z.object({
          ok: z.literal(true),
          service: z.string(),
        }),
      ),

    delayedPublish: oc
      .route({
        method: "POST",
        path: "/things/test/delayed-publish",
        summary: "Publish arbitrary event after a delay",
        tags: ["things", "testing"],
      })
      .input(DelayedPublishInput)
      .output(DelayedPublishOutput),
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

export const ExampleServiceEnv = z.object({
  EXAMPLE_SERVICE_PORT: z.coerce.number().int().min(0).max(65535).default(0),
  EXAMPLE_DB_PATH: nonEmptyStringWithTrimDefault("/var/lib/jonasland/example.sqlite"),
});

export type ExampleServiceEnv = z.infer<typeof ExampleServiceEnv>;

export {
  Thing as thingSchema,
  CreateThingInput as createThingInputSchema,
  ListThingsInput as listThingsInputSchema,
  UpdateThingInput as updateThingInputSchema,
  DelayedPublishInput as delayedPublishInputSchema,
  DelayedPublishOutput as delayedPublishOutputSchema,
  EchoOutput as echoOutputSchema,
  ExampleServiceEnv as exampleServiceEnvSchema,
};

export const exampleServiceManifest = {
  name: packageJson.name,
  slug: "example",
  version: packageJson.version ?? "0.0.0",
  port: 0,
  serverEntryPoint: "services/example/src/server.ts",
  orpcContract: exampleContract,
  envVars: ExampleServiceEnv,
} as const satisfies ServiceManifestWithEntryPoint;
