import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { oc, type ContractRouterClient } from "@orpc/contract";
import { z } from "zod";

// ---------------------------------------------------------------------------
// The auth worker exposes THREE surfaces to other code; this package is the
// shared contract for two of them:
//
//  1. `authContract` — the oRPC HTTP API at `/api/orpc/*` on the auth worker's
//     public hostname. Callers are the auth app's own UI (session cookie), the
//     `iterate` CLI (bearer token from the device/OAuth flow), and deploy-time
//     Node scripts (service token) — things that can only speak HTTP.
//  2. `AuthWorkerRpc` — the Workers RPC methods on the auth worker's default
//     entrypoint (apps/auth/src/server/worker.ts). OS workers call these over
//     a Cloudflare service binding instead of the public internet; the
//     binding itself is the credential, so there is no token header.
//     https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/
//
// (The third surface — the OIDC/OAuth2 protocol under `/api/auth/*` — is
// standards-shaped and deliberately NOT modeled here; relying parties use
// `@iterate-com/auth/server` or plain oauth4webapi against the public
// hostname.)
// ---------------------------------------------------------------------------

/** Shared-secret header for deploy-time scripts calling `internal.*` HTTP
 * procedures. Runtime OS→auth calls use the service binding instead. */
export const SERVICE_TOKEN_HEADER = "x-iterate-service-token";

export const OrganizationRole = z.enum(["member", "admin", "owner"]);
export type OrganizationRole = z.infer<typeof OrganizationRole>;

const OrganizationRecord = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
});

export const OrganizationSummary = OrganizationRecord.extend({
  role: OrganizationRole,
});
export type OrganizationSummary = z.infer<typeof OrganizationSummary>;

export const ProjectRecord = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  slug: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  archivedAt: z.string().nullable(),
});
export type ProjectRecord = z.infer<typeof ProjectRecord>;

const CallerManagedProjectId = z
  .string()
  .trim()
  .min(1)
  .describe("Opaque caller-managed project ID. If omitted, auth generates a prj_* ID.");

const CreateClientInput = z.object({
  clientName: z.string().min(1),
  redirectURIs: z.array(z.url()).min(1),
});

export const OAuthClientRecord = z.object({
  clientId: z.string(),
  clientName: z.string(),
  clientSecret: z.string(),
  redirectURIs: z.array(z.url()),
});
export type OAuthClientRecord = z.infer<typeof OAuthClientRecord>;

const OrgInput = z.object({
  organizationSlug: z.string().min(1),
});

export const ProjectInput = z.object({
  projectSlug: z.string().min(1),
});
export type ProjectInput = z.infer<typeof ProjectInput>;

export const CreateProjectForOrganizationInput = z.object({
  id: CallerManagedProjectId.optional(),
  organizationSlug: z.string().min(1),
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(50).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CreateProjectForOrganizationInput = z.infer<typeof CreateProjectForOrganizationInput>;

const InternalEnsureOAuthClientInput = z.object({
  referenceId: z.string().min(1),
  clientName: z.string().min(1),
  redirectURIs: z.array(z.url()).min(1),
  existingClientId: z.string().min(1).optional(),
  existingClientSecret: z.string().min(1).optional(),
  rotateClientSecret: z.boolean().optional(),
});

const InternalSetOAuthClientInput = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(16),
  clientName: z.string().min(1),
  redirectURIs: z.array(z.url()).min(1),
  referenceId: z.string().min(1).optional(),
  skipConsent: z.boolean().optional(),
});

const OAuthProjectSelectionInput = z.object({
  clientId: z.string().min(1),
  projectIds: z.array(z.string().min(1)).min(1),
});

// ---------------------------------------------------------------------------
// Workers RPC surface (service binding)
// ---------------------------------------------------------------------------

/** One row of `listProjectsForUser` — the projects a user can reach through
 * any organization membership. Slimmer than ProjectRecord on purpose: the OS
 * stale-claims check only needs identity. */
export const UserProjectRecord = z.object({
  id: z.string(),
  slug: z.string(),
  organizationId: z.string(),
});
export type UserProjectRecord = z.infer<typeof UserProjectRecord>;

/**
 * The auth worker's Workers-RPC methods, implemented on the default
 * entrypoint in apps/auth/src/server/worker.ts and consumed by OS workers
 * through the `AUTH` service binding (apps/os/alchemy.run.ts).
 *
 * Trust model: a service binding can only be created by a deploy into the
 * same Cloudflare account, so possession of the binding IS the
 * authorization — these methods are as trusted as the old
 * x-iterate-service-token HTTP calls they replace. Callers do their own
 * user-level authorization (e.g. OS checks org membership from verified JWT
 * claims before calling createProjectForOrganization).
 */
export interface AuthWorkerRpc {
  /** Create (or re-adopt, see apps/auth project-slugs resolution) a project
   * owned by an organization. Auth mints the canonical `prj_` id. */
  createProjectForOrganization(input: CreateProjectForOrganizationInput): Promise<ProjectRecord>;
  /** Slug -> project lookup for OS ingress and directory reads. Null when no
   * project has the slug. */
  getProjectBySlug(input: ProjectInput): Promise<ProjectRecord | null>;
  /** Every project the user can reach via org membership — OS uses this for
   * the stale-claims window right after a project is created. */
  listProjectsForUser(input: { userId: string }): Promise<UserProjectRecord[]>;
  /** Mint a canonical `prj_` id without creating an auth-side project — for
   * OS operator/recovery creates with no owning organization. */
  mintProjectId(): Promise<{ id: string }>;
}

// ---------------------------------------------------------------------------
// HTTP oRPC contract (public hostname, /api/orpc/*)
// ---------------------------------------------------------------------------

export const authContract = oc.router({
  user: {
    myOrganizations: oc
      .route({
        method: "GET",
        path: "/user/my-organizations",
        summary: "List organizations for the current authenticated user",
        tags: ["user", "organization"],
      })
      .output(z.array(OrganizationSummary)),
    storeOAuthProjectSelection: oc
      .route({
        method: "POST",
        path: "/user/store-oauth-project-selection",
        summary: "Store selected projects for the current OAuth authorization flow",
        tags: ["user", "oauth"],
      })
      .input(OAuthProjectSelectionInput)
      .output(z.object({ success: z.literal(true) })),
  },
  organization: {
    create: oc
      .route({
        method: "POST",
        path: "/organization/create",
        summary: "Create an organization",
        tags: ["organization"],
      })
      .input(z.object({ name: z.string().min(1).max(100) }))
      .output(OrganizationRecord),
    delete: oc
      .route({
        method: "POST",
        path: "/organization/delete",
        summary: "Delete an organization",
        tags: ["organization"],
      })
      .input(OrgInput)
      .output(z.object({ success: z.literal(true) })),
  },
  project: {
    list: oc
      .route({
        method: "GET",
        path: "/project/list",
        summary: "List project containers for an organization",
        tags: ["project"],
      })
      .input(OrgInput)
      .output(z.array(ProjectRecord)),
    create: oc
      .route({
        method: "POST",
        path: "/project/create",
        summary: "Create a project container",
        tags: ["project"],
      })
      .input(
        z.object({
          ...OrgInput.shape,
          name: z.string().min(1).max(100),
          slug: z.string().min(1).max(50).optional(),
        }),
      )
      .output(ProjectRecord),
    delete: oc
      .route({
        method: "POST",
        path: "/project/delete",
        summary: "Delete a project container",
        tags: ["project"],
      })
      .input(ProjectInput)
      .output(z.object({ success: z.literal(true) })),
  },
  admin: {
    oauth: {
      createClient: oc
        .route({
          method: "POST",
          path: "/admin/oauth/create-client",
          summary: "Create a new OAuth client",
          tags: ["admin", "oauth"],
        })
        .input(CreateClientInput)
        .output(OAuthClientRecord),
      listClients: oc
        .route({
          method: "GET",
          path: "/admin/oauth/list-clients",
          summary: "List all OAuth clients",
          tags: ["admin", "oauth"],
        })
        .output(z.array(OAuthClientRecord.omit({ clientSecret: true }))),
    },
  },
  // Deploy-time-only procedures, authenticated by SERVICE_TOKEN_HEADER. These
  // stay HTTP (not Workers RPC) because their callers are Node processes —
  // alchemy deploys and Doppler sync scripts — which cannot hold a service
  // binding.
  internal: {
    oauth: {
      ensureClient: oc
        .route({
          method: "POST",
          path: "/internal/oauth/ensure-client",
          summary: "Ensure a service-managed OAuth client exists",
          tags: ["internal", "oauth"],
        })
        .input(InternalEnsureOAuthClientInput)
        .output(OAuthClientRecord),
      setClient: oc
        .route({
          method: "POST",
          path: "/internal/oauth/set-client",
          summary:
            "Declaratively upsert an OAuth client with caller-provided credentials (Doppler is the source of truth; idempotent, never rotates)",
          tags: ["internal", "oauth"],
        })
        .input(InternalSetOAuthClientInput)
        .output(OAuthClientRecord),
    },
  },
});
export type AuthContractClient = ContractRouterClient<typeof authContract>;

export type AuthContractClientOptions = {
  baseUrl: string;
  serviceToken?: string;
  fetch?: typeof fetch;
};

export function createAuthContractClient(options: AuthContractClientOptions): AuthContractClient {
  const authBaseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? fetch;

  return createORPCClient(
    new RPCLink({
      url: `${authBaseUrl}/api/orpc/`,
      fetch: (request: URL | Request, init?: RequestInit) => {
        const headers = mergeRequestHeaders(request, init?.headers);
        if (options.serviceToken) {
          headers.set(SERVICE_TOKEN_HEADER, options.serviceToken);
        }
        return fetchImpl(request, { ...init, headers });
      },
    }),
  ) as AuthContractClient;
}

function mergeRequestHeaders(
  request: URL | Request,
  initHeaders: ConstructorParameters<typeof Headers>[0] | undefined,
) {
  const headers = new Headers(request instanceof Request ? request.headers : undefined);
  if (initHeaders) {
    for (const [key, value] of new Headers(initHeaders)) {
      headers.set(key, value);
    }
  }
  return headers;
}
