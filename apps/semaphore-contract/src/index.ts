import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { oc } from "@orpc/contract";
import { z } from "zod/v4";

export const semaphoreInputStringSchema = z.string().trim().min(1);
export const semaphoreSlugSchema = semaphoreInputStringSchema;

export const semaphoreDataSchema = z.record(z.string(), z.unknown());

export const resourceRecordSchema = z.object({
  type: semaphoreInputStringSchema,
  slug: semaphoreInputStringSchema,
  data: semaphoreDataSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const leaseRecordSchema = z.object({
  type: semaphoreInputStringSchema,
  slug: semaphoreInputStringSchema,
  data: semaphoreDataSchema,
  leaseId: z.string().uuid(),
  expiresAt: z.number().int().positive(),
});

export const addResourceInputSchema = z.object({
  type: semaphoreInputStringSchema,
  slug: semaphoreInputStringSchema,
  data: semaphoreDataSchema,
});

export const deleteResourceInputSchema = z.object({
  type: semaphoreInputStringSchema,
  slug: semaphoreInputStringSchema,
});

export const listResourcesInputSchema = z.object({
  type: semaphoreInputStringSchema.optional(),
});

export const acquireResourceInputSchema = z.object({
  type: semaphoreInputStringSchema,
  leaseMs: z.number().int().positive(),
  waitMs: z.number().int().nonnegative().optional(),
});

export const releaseResourceInputSchema = z.object({
  type: semaphoreInputStringSchema,
  slug: semaphoreInputStringSchema,
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

export type SemaphoreClient = ContractRouterClient<typeof semaphoreContract>;
export type SemaphoreFetch = (
  input: URL | string | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface CreateSemaphoreClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: SemaphoreFetch;
}

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
