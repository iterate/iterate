import { oc } from "@orpc/contract";
import { z } from "zod";

export const SEMAPHORE_KEY_PATTERN = /^(?=.*[a-z])[a-z0-9-]+$/;
export const MAX_LEASE_MS = 60 * 60 * 1000;
export const MAX_WAIT_MS = 5 * 60 * 1000;

export const semaphoreKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(SEMAPHORE_KEY_PATTERN, "must match ^(?=.*[a-z])[a-z0-9-]+$");
export const semaphoreTypeSchema = semaphoreKeySchema;
export const semaphoreSlugSchema = semaphoreKeySchema;

export type SemaphoreJsonObject = Record<string, unknown>;

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (typeof value === "object") {
    return Object.values(value).every(isJsonValue);
  }

  return false;
}

export const semaphoreDataSchema = z
  .record(z.string(), z.unknown())
  .superRefine((value, context) => {
    if (!isJsonValue(value)) {
      context.addIssue({
        code: "custom",
        message: "data must be a JSON-serializable object",
      });
    }
  });
export const semaphoreLeaseMsSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_LEASE_MS, `leaseMs must be <= ${MAX_LEASE_MS}`);
export const semaphoreWaitMsSchema = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_WAIT_MS, `waitMs must be <= ${MAX_WAIT_MS}`);
export const SemaphoreLeaseState = z.enum(["available", "leased"]);

export const SemaphoreResourceRecord = z.object({
  type: semaphoreTypeSchema,
  slug: semaphoreSlugSchema,
  data: semaphoreDataSchema,
  leaseState: SemaphoreLeaseState,
  leasedUntil: z.number().int().positive().nullable(),
  lastAcquiredAt: z.number().int().positive().nullable(),
  lastReleasedAt: z.number().int().positive().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const SemaphoreLeaseRecord = z.object({
  type: semaphoreTypeSchema,
  slug: semaphoreSlugSchema,
  data: semaphoreDataSchema,
  leaseId: z.string().uuid(),
  expiresAt: z.number().int().positive(),
});

export const AddResourceInput = z.object({
  type: semaphoreTypeSchema,
  slug: semaphoreSlugSchema,
  data: semaphoreDataSchema,
});

export const DeleteResourceInput = z.object({
  type: semaphoreTypeSchema,
  slug: semaphoreSlugSchema,
});

export const ListResourcesInput = z.object({
  type: semaphoreTypeSchema.optional(),
});

export const AcquireResourceInput = z.object({
  type: semaphoreTypeSchema,
  leaseMs: semaphoreLeaseMsSchema,
  waitMs: semaphoreWaitMsSchema.optional(),
});

export const ReleaseResourceInput = z.object({
  type: semaphoreTypeSchema,
  slug: semaphoreSlugSchema,
  leaseId: z.string().uuid(),
});

export const DeleteResourceResult = z.object({
  deleted: z.boolean(),
});

export const ReleaseResourceResult = z.object({
  released: z.boolean(),
});

export const semaphoreContract = oc.router({
  resources: oc.router({
    add: oc
      .route({
        method: "POST",
        path: "/resources",
        summary: "Add a resource to the semaphore inventory",
        tags: ["resources"],
      })
      .input(AddResourceInput)
      .output(SemaphoreResourceRecord),

    delete: oc
      .route({
        method: "DELETE",
        path: "/resources/{type}/{slug}",
        summary: "Delete a resource from the semaphore inventory",
        tags: ["resources"],
      })
      .input(DeleteResourceInput)
      .output(DeleteResourceResult),

    list: oc
      .route({
        method: "GET",
        path: "/resources",
        summary: "List semaphore resources",
        tags: ["resources"],
      })
      .input(ListResourcesInput)
      .output(z.array(SemaphoreResourceRecord)),

    acquire: oc
      .route({
        method: "POST",
        path: "/resources/acquire",
        summary: "Acquire a lease for the next available resource of a type",
        tags: ["resources"],
      })
      .input(AcquireResourceInput)
      .output(SemaphoreLeaseRecord),

    release: oc
      .route({
        method: "POST",
        path: "/resources/release",
        summary: "Release an active resource lease",
        tags: ["resources"],
      })
      .input(ReleaseResourceInput)
      .output(ReleaseResourceResult),
  }),
});

export type SemaphoreResourceRecord = z.infer<typeof SemaphoreResourceRecord>;
export type SemaphoreLeaseRecord = z.infer<typeof SemaphoreLeaseRecord>;
