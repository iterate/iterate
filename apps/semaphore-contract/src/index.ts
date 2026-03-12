import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { oc } from "@orpc/contract";
import { z } from "zod/v4";

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

export const resourceRecordSchema = z.object({
  type: semaphoreTypeSchema,
  slug: semaphoreSlugSchema,
  data: semaphoreDataSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const leaseRecordSchema = z.object({
  type: semaphoreTypeSchema,
  slug: semaphoreSlugSchema,
  data: semaphoreDataSchema,
  leaseId: z.string().uuid(),
  expiresAt: z.number().int().positive(),
});

export const addResourceInputSchema = z.object({
  type: semaphoreTypeSchema,
  slug: semaphoreSlugSchema,
  data: semaphoreDataSchema,
});

export const deleteResourceInputSchema = z.object({
  type: semaphoreTypeSchema,
  slug: semaphoreSlugSchema,
});

export const listResourcesInputSchema = z.object({
  type: semaphoreTypeSchema.optional(),
});

export const acquireResourceInputSchema = z.object({
  type: semaphoreTypeSchema,
  leaseMs: semaphoreLeaseMsSchema,
  waitMs: semaphoreWaitMsSchema.optional(),
});

export const releaseResourceInputSchema = z.object({
  type: semaphoreTypeSchema,
  slug: semaphoreSlugSchema,
  leaseId: z.string().uuid(),
});

export const deleteResourceResultSchema = z.object({
  deleted: z.boolean(),
});

export const releaseResourceResultSchema = z.object({
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
      .input(addResourceInputSchema)
      .output(resourceRecordSchema),

    delete: oc
      .route({
        method: "DELETE",
        path: "/resources/{type}/{slug}",
        summary: "Delete a resource from the semaphore inventory",
        tags: ["resources"],
      })
      .input(deleteResourceInputSchema)
      .output(deleteResourceResultSchema),

    list: oc
      .route({
        method: "GET",
        path: "/resources",
        summary: "List semaphore resources",
        tags: ["resources"],
      })
      .input(listResourcesInputSchema)
      .output(z.array(resourceRecordSchema)),

    acquire: oc
      .route({
        method: "POST",
        path: "/resources/acquire",
        summary: "Acquire a lease for the next available resource of a type",
        tags: ["resources"],
      })
      .input(acquireResourceInputSchema)
      .output(leaseRecordSchema),

    release: oc
      .route({
        method: "POST",
        path: "/resources/release",
        summary: "Release an active resource lease",
        tags: ["resources"],
      })
      .input(releaseResourceInputSchema)
      .output(releaseResourceResultSchema),
  }),
});

export type SemaphoreResourceRecord = z.infer<typeof resourceRecordSchema>;
export type SemaphoreLeaseRecord = z.infer<typeof leaseRecordSchema>;
export type SemaphoreClient = ContractRouterClient<typeof semaphoreContract>;
export type SemaphoreFetch = (
  input: URL | string | Request,
  init?: RequestInit,
) => Promise<Response>;

export type CreateSemaphoreClientOptions =
  | {
      apiKey: string;
      baseUrl: string;
      fetch?: SemaphoreFetch;
    }
  | {
      apiKey: string;
      fetch: SemaphoreFetch;
      baseUrl?: string;
    };

export const FETCH_ONLY_PLACEHOLDER_URL = "https://semaphore.invalid/api/orpc";

export function resolveSemaphoreOrpcUrl(options: {
  baseUrl?: string;
  fetch?: SemaphoreFetch;
}): string {
  if (options.baseUrl) {
    return new URL("/api/orpc", options.baseUrl).toString();
  }

  if (options.fetch) {
    return FETCH_ONLY_PLACEHOLDER_URL;
  }

  throw new Error("createSemaphoreClient requires either baseUrl or fetch");
}

export function createSemaphoreClient(options: CreateSemaphoreClientOptions): SemaphoreClient {
  const url = resolveSemaphoreOrpcUrl(options);

  // RPCLink still expects a URL even when callers provide a custom fetch. Using a placeholder here
  // lets service-binding or loopback fetchers handle dispatch without a public base URL.
  const link = new RPCLink({
    url,
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
    },
    ...(options.fetch
      ? {
          fetch: (input: URL | string | Request, init?: RequestInit) => options.fetch!(input, init),
        }
      : {}),
  });

  return createORPCClient(link);
}
