import { eventIterator, oc } from "@orpc/contract";
import { internalContract } from "@iterate-com/shared/apps/internal-router-contract";
import { z } from "zod";

const Thing = z.object({
  id: z.string(),
  thing: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const RandomLogStreamRequest = z
  .object({
    count: z
      .number()
      .int("Number of random numbers must be a whole number")
      .min(1, "Number of random numbers must be at least 1")
      .max(500, "Number of random numbers must be at most 500"),
    minDelayMs: z
      .number()
      .int("Minimum delay must be a whole number")
      .min(0, "Minimum delay must be at least 0")
      .max(10_000, "Minimum delay must be at most 10000"),
    maxDelayMs: z
      .number()
      .int("Maximum delay must be a whole number")
      .min(1, "Maximum delay must be at least 1")
      .max(10_000, "Maximum delay must be at most 10000"),
  })
  .superRefine((value, ctx) => {
    if (value.minDelayMs >= value.maxDelayMs) {
      ctx.addIssue({
        code: "custom",
        path: ["maxDelayMs"],
        message: "Maximum delay must be greater than minimum delay",
      });
    }
  });

export const RandomLogStreamFormSchema = z
  .object({
    count: z
      .string()
      .trim()
      .min(1, "Number of random numbers is required")
      .refine((value) => !Number.isNaN(Number(value)), "Number of random numbers must be a number")
      .transform((value) => Number(value))
      .pipe(
        z
          .number()
          .int("Number of random numbers must be a whole number")
          .min(1, "Number of random numbers must be at least 1")
          .max(500, "Number of random numbers must be at most 500"),
      ),
    minDelayMs: z
      .string()
      .trim()
      .min(1, "Minimum delay is required")
      .refine((value) => !Number.isNaN(Number(value)), "Minimum delay must be a number")
      .transform((value) => Number(value))
      .pipe(
        z
          .number()
          .int("Minimum delay must be a whole number")
          .min(0, "Minimum delay must be at least 0")
          .max(10_000, "Minimum delay must be at most 10000"),
      ),
    maxDelayMs: z
      .string()
      .trim()
      .min(1, "Maximum delay is required")
      .refine((value) => !Number.isNaN(Number(value)), "Maximum delay must be a number")
      .transform((value) => Number(value))
      .pipe(
        z
          .number()
          .int("Maximum delay must be a whole number")
          .min(1, "Maximum delay must be at least 1")
          .max(10_000, "Maximum delay must be at most 10000"),
      ),
  })
  .pipe(RandomLogStreamRequest);

export type RandomLogStreamFormValues = z.input<typeof RandomLogStreamFormSchema>;
export type RandomLogStreamRequest = z.infer<typeof RandomLogStreamRequest>;

/**
 * Shared source of truth for the example app's typed RPC surface.
 *
 * `implement(exampleContract)` in `apps/example/src/api/base.ts` binds the
 * server implementation to this contract, and `os.router({...})` in
 * `apps/example/src/api/router.ts` provides the actual handlers.
 *
 * The `__internal.*` subtree is the shared app-level operator/debug namespace that
 * all apps may expose under `/__internal/*`, while the rest of this file is the
 * example app's own domain-specific surface.
 */
export const exampleContract = oc.router({
  __internal: internalContract,
  ping: oc
    .route({ method: "GET", path: "/ping", description: "Ping", tags: ["debug"] })
    .input(z.object({}).optional().default({}))
    .output(z.object({ message: z.string(), serverTime: z.string() })),
  pirateSecret: oc
    .route({
      method: "GET",
      path: "/pirate-secret",
      description: "Reveal the configured pirate secret",
      tags: ["debug"],
    })
    .input(z.object({}).optional().default({}))
    .output(z.object({ secret: z.string() })),
  test: {
    logDemo: oc
      .route({
        method: "POST",
        path: "/test/log-demo",
        description: "Emit staggered info, warn, and error server logs with structured payloads",
        tags: ["debug", "test"],
      })
      .input(z.object({ label: z.string().trim().min(1).default("frontend-button") }))
      .output(
        z.object({
          ok: z.literal(true),
          label: z.string(),
          requestId: z.string(),
          steps: z.array(z.string()),
        }),
      ),
    serverThrow: oc
      .route({
        method: "POST",
        path: "/test/server-throw",
        description: "Throw a real server exception for stack trace testing",
        tags: ["debug", "test"],
      })
      .input(
        z.object({
          message: z.string().trim().min(1).default("Example server test exception"),
        }),
      )
      .output(z.never()),
    randomLogStream: oc
      .route({
        method: "POST",
        path: "/test/random-log-stream",
        description: "Stream random log lines with variable delays",
        tags: ["debug", "test"],
      })
      .input(RandomLogStreamRequest)
      // `eventIterator(...)` keeps the contract explicit on both server and
      // client for async-iterable responses.
      // https://orpc.dev/docs/event-iterator
      // https://orpc.dev/docs/client/event-iterator
      .output(eventIterator(z.string())),
  },
  things: {
    create: oc
      .route({ method: "POST", path: "/things", description: "Create a thing", tags: ["things"] })
      .input(z.object({ thing: z.string().min(1) }))
      .output(Thing),
    list: oc
      .route({ method: "GET", path: "/things", description: "List things", tags: ["things"] })
      .input(
        z.object({
          limit: z.coerce.number().int().min(1).max(100).optional().default(20),
          offset: z.coerce.number().int().min(0).optional().default(0),
        }),
      )
      .output(z.object({ things: z.array(Thing), total: z.number().int().nonnegative() })),
    find: oc
      .route({
        method: "GET",
        path: "/things/{id}",
        description: "Get thing by id",
        tags: ["things"],
      })
      .input(z.object({ id: z.string() }))
      .output(Thing),
    remove: oc
      .route({
        method: "DELETE",
        path: "/things/{id}",
        description: "Delete thing",
        tags: ["things"],
      })
      .input(z.object({ id: z.string() }))
      .output(z.object({ ok: z.literal(true), id: z.string(), deleted: z.boolean() })),
  },
});
