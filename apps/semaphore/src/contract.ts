import { createORPCClient } from "@orpc/client";
import { oc, type ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { z } from "zod";

const INTERNAL_OPENAPI_TAG = "/__internal";
const SEMAPHORE_KEY_PATTERN = /^(?=.*[a-z])[a-z0-9-]+$/;
const MAX_LEASE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_WAIT_MS = 5 * 60 * 1000;

const EmptyInput = z.object({}).optional().default({});

const internalContract = oc.router({
  health: oc
    .route({ method: "GET", path: "/__internal/health", tags: [INTERNAL_OPENAPI_TAG] })
    .input(EmptyInput)
    .output(
      z.object({
        ok: z.literal(true),
        app: z.string(),
        version: z.string(),
      }),
    ),
  publicConfig: oc
    .route({ method: "GET", path: "/__internal/public-config", tags: [INTERNAL_OPENAPI_TAG] })
    .input(EmptyInput)
    .output(z.record(z.string(), z.unknown())),
  debug: oc
    .route({ method: "GET", path: "/__internal/debug", tags: [INTERNAL_OPENAPI_TAG] })
    .input(EmptyInput)
    .output(z.record(z.string(), z.unknown())),
  trpcCliProcedures: oc
    .route({
      method: "GET",
      path: "/__internal/trpc-cli-procedures",
      tags: [INTERNAL_OPENAPI_TAG],
    })
    .input(EmptyInput)
    .output(
      z.object({
        procedures: z.array(z.unknown()),
      }),
    ),
  refreshRegistry: oc
    .route({ method: "POST", path: "/__internal/refresh-registry", tags: [INTERNAL_OPENAPI_TAG] })
    .input(
      z
        .object({
          registryBaseUrl: z.url().default("http://iterate.localhost"),
          baseUrl: z.url().optional(),
        })
        .optional()
        .default({ registryBaseUrl: "http://iterate.localhost" }),
    )
    .output(
      z.object({
        ok: z.literal(true),
      }),
    ),
});

const semaphoreKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(SEMAPHORE_KEY_PATTERN, "must match ^(?=.*[a-z])[a-z0-9-]+$");
export const semaphoreTypeSchema = semaphoreKeySchema;
const semaphoreSlugSchema = semaphoreKeySchema;

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
const SemaphoreLeaseState = z.enum(["available", "leased"]);

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
  leaseId: z.uuid(),
  expiresAt: z.number().int().positive(),
});

const AddResourceInput = z.object({
  type: semaphoreTypeSchema,
  slug: semaphoreSlugSchema,
  data: semaphoreDataSchema,
});

export const DeleteResourceInput = z.object({
  type: semaphoreTypeSchema,
  slug: semaphoreSlugSchema,
});

const ListResourcesInput = z.object({
  type: semaphoreTypeSchema.optional(),
});

export const FindResourceInput = z.object({
  type: semaphoreTypeSchema,
  slug: semaphoreSlugSchema,
});

export const AcquireResourceInput = z.object({
  type: semaphoreTypeSchema,
  leaseMs: semaphoreLeaseMsSchema,
  waitMs: semaphoreWaitMsSchema.optional(),
});

const AcquireSpecificResourceInput = z.object({
  type: semaphoreTypeSchema,
  slug: semaphoreSlugSchema,
  leaseMs: semaphoreLeaseMsSchema,
});

const RenewResourceLeaseInput = z.object({
  type: semaphoreTypeSchema,
  slug: semaphoreSlugSchema,
  leaseId: z.uuid(),
  leaseMs: semaphoreLeaseMsSchema,
});

export const ReleaseResourceInput = z.object({
  type: semaphoreTypeSchema,
  slug: semaphoreSlugSchema,
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

export const cloudflareTunnelType = "cloudflare-tunnel";

export const CloudflareTunnelData = z.object({
  provider: z.literal(cloudflareTunnelType),
  publicHostname: z.string().min(1),
  tunnelId: z.string().min(1),
  tunnelName: z.string().min(1),
  tunnelToken: z.string().min(1),
  service: z.string().min(1),
  createdAt: z.string().min(1),
});

export type CloudflareTunnelData = z.infer<typeof CloudflareTunnelData>;

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

const FETCH_ONLY_PLACEHOLDER_URL = "https://semaphore.invalid/api";

function resolveSemaphoreOrpcUrl(options: { baseURL?: string; fetch?: SemaphoreFetch }): string {
  if (options.baseURL) {
    return new URL("/api", options.baseURL).toString();
  }

  if (options.fetch) {
    return FETCH_ONLY_PLACEHOLDER_URL;
  }

  throw new Error("createSemaphoreClient requires either baseURL or fetch");
}

export function createSemaphoreClient(options: CreateSemaphoreClientOptions): SemaphoreClient {
  const url = resolveSemaphoreOrpcUrl(options);
  const authFetch: SemaphoreFetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${options.apiKey}`);

    return (options.fetch ?? fetch)(input, {
      ...init,
      headers,
    });
  };

  const link = new OpenAPILink(semaphoreContract, {
    url,
    fetch: authFetch,
  });

  return createORPCClient(link);
}
