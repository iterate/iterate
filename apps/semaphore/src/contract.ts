import { createORPCClient } from "@orpc/client";
import { oc, type ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { internalContract } from "@iterate-com/shared/apps/internal-router-contract";
import { z } from "zod";

/**
 * oRPC contract for the semaphore app, plus `createSemaphoreClient` for typed
 * HTTP access. Everything that talks to semaphore imports from this one file:
 * the worker implementation (`src/orpc/*`), the seed scripts, the e2e tests,
 * and the repo-root preview tooling (`scripts/preview/router.ts`).
 */

const MAX_LEASE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_WAIT_MS = 5 * 60 * 1000;

/** Resource `type` and `slug` share one format: lowercase slugs like `preview-4`. */
export const semaphoreKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.*[a-z])[a-z0-9-]+$/, "must match ^(?=.*[a-z])[a-z0-9-]+$");

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

// Validated with a refinement rather than `z.json()` so the inferred type stays
// `Record<string, unknown>` instead of pushing a recursive JSONValue type through
// every handler and Durable Object signature.
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
const semaphoreLeaseMsSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_LEASE_MS, `leaseMs must be <= ${MAX_LEASE_MS}`);
const semaphoreWaitMsSchema = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_WAIT_MS, `waitMs must be <= ${MAX_WAIT_MS}`);

export const SemaphoreResourceRecord = z.object({
  type: semaphoreKeySchema,
  slug: semaphoreKeySchema,
  data: semaphoreDataSchema,
  leaseState: z.enum(["available", "leased"]),
  leasedUntil: z.number().int().positive().nullable(),
  lastAcquiredAt: z.number().int().positive().nullable(),
  lastReleasedAt: z.number().int().positive().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const SemaphoreLeaseRecord = z.object({
  type: semaphoreKeySchema,
  slug: semaphoreKeySchema,
  data: semaphoreDataSchema,
  leaseId: z.uuid(),
  expiresAt: z.number().int().positive(),
});

const AddResourceInput = z.object({
  type: semaphoreKeySchema,
  slug: semaphoreKeySchema,
  data: semaphoreDataSchema,
});

export const DeleteResourceInput = z.object({
  type: semaphoreKeySchema,
  slug: semaphoreKeySchema,
});

const ListResourcesInput = z.object({
  type: semaphoreKeySchema.optional(),
});

export const FindResourceInput = z.object({
  type: semaphoreKeySchema,
  slug: semaphoreKeySchema,
});

export const AcquireResourceInput = z.object({
  type: semaphoreKeySchema,
  leaseMs: semaphoreLeaseMsSchema,
  waitMs: semaphoreWaitMsSchema.optional(),
});

const AcquireSpecificResourceInput = z.object({
  type: semaphoreKeySchema,
  slug: semaphoreKeySchema,
  leaseMs: semaphoreLeaseMsSchema,
});

const RenewResourceLeaseInput = z.object({
  type: semaphoreKeySchema,
  slug: semaphoreKeySchema,
  leaseId: z.uuid(),
  leaseMs: semaphoreLeaseMsSchema,
});

export const ReleaseResourceInput = z.object({
  type: semaphoreKeySchema,
  slug: semaphoreKeySchema,
  leaseId: z.uuid(),
});

const DeleteResourceResult = z.object({
  deleted: z.boolean(),
});

const ReleaseResourceResult = z.object({
  released: z.boolean(),
});

export const semaphoreContract = oc.router({
  __internal: internalContract,
  resources: oc.router({
    add: oc
      .route({
        method: "POST",
        path: "/resources",
        tags: ["/resources"],
      })
      .input(AddResourceInput)
      .output(SemaphoreResourceRecord),

    delete: oc
      .route({
        method: "DELETE",
        path: "/resources/{type}/{slug}",
        tags: ["/resources"],
      })
      .input(DeleteResourceInput)
      .output(DeleteResourceResult),

    list: oc
      .route({
        method: "GET",
        path: "/resources",
        tags: ["/resources"],
      })
      .input(ListResourcesInput)
      .output(z.array(SemaphoreResourceRecord)),

    find: oc
      .route({
        method: "GET",
        path: "/resources/{type}/{slug}",
        tags: ["/resources"],
      })
      .input(FindResourceInput)
      .output(SemaphoreResourceRecord),

    acquire: oc
      .route({
        method: "POST",
        path: "/resources/acquire",
        tags: ["/resources"],
      })
      .input(AcquireResourceInput)
      .output(SemaphoreLeaseRecord),

    acquireSpecific: oc
      .route({
        method: "POST",
        path: "/resources/acquire-specific",
        tags: ["/resources"],
      })
      .input(AcquireSpecificResourceInput)
      .output(SemaphoreLeaseRecord.nullable()),

    renew: oc
      .route({
        method: "POST",
        path: "/resources/renew",
        tags: ["/resources"],
      })
      .input(RenewResourceLeaseInput)
      .output(SemaphoreLeaseRecord.nullable()),

    release: oc
      .route({
        method: "POST",
        path: "/resources/release",
        tags: ["/resources"],
      })
      .input(ReleaseResourceInput)
      .output(ReleaseResourceResult),
  }),
});

export type SemaphoreResourceRecord = z.infer<typeof SemaphoreResourceRecord>;
export type SemaphoreLeaseRecord = z.infer<typeof SemaphoreLeaseRecord>;

type SemaphoreClient = ContractRouterClient<typeof semaphoreContract>;
type SemaphoreFetch = (input: URL | string | Request, init?: RequestInit) => Promise<Response>;

type CreateSemaphoreClientOptions =
  | {
      apiKey: string;
      baseURL: string;
      fetch?: SemaphoreFetch;
    }
  | {
      apiKey: string;
      fetch: SemaphoreFetch;
      baseURL?: string;
    };

export function createSemaphoreClient(options: CreateSemaphoreClientOptions): SemaphoreClient {
  if (!options.baseURL && !options.fetch) {
    throw new Error("createSemaphoreClient requires either baseURL or fetch");
  }

  // OpenAPILink always needs a URL. When the caller supplies a custom `fetch`
  // (e.g. a Cloudflare service binding) we use the IANA-reserved `.invalid`
  // TLD (RFC 2606) so a misconfigured client fails fast instead of reaching a
  // real host.
  const url = options.baseURL
    ? new URL("/api", options.baseURL).toString()
    : "https://semaphore.invalid/api";

  const authFetch: SemaphoreFetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${options.apiKey}`);

    return (options.fetch ?? fetch)(input, {
      ...init,
      headers,
    });
  };

  return createORPCClient(new OpenAPILink(semaphoreContract, { url, fetch: authFetch }));
}
