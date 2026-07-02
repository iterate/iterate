import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { oc, type ContractRouterClient } from "@orpc/contract";
import { z } from "zod";

export const SERVICE_TOKEN_HEADER = "x-iterate-service-token";
export const AS_USER_HEADER = "x-iterate-as-user";

export const OrganizationRole = z.enum(["member", "admin", "owner"]);
export type OrganizationRole = z.infer<typeof OrganizationRole>;

export const UserRecord = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
  image: z.string().nullable(),
  role: z.string().nullable(),
});
export type UserRecord = z.infer<typeof UserRecord>;

export const OrganizationRecord = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
});
export type OrganizationRecord = z.infer<typeof OrganizationRecord>;

export const OrganizationSummary = OrganizationRecord.extend({
  role: OrganizationRole,
});
export type OrganizationSummary = z.infer<typeof OrganizationSummary>;

const AccessTokenOrganizationClaim = OrganizationSummary.extend({
  name: z.string().optional(),
});

const AccessTokenProjectClaim = z.object({
  id: z.string(),
  slug: z.string(),
  organizationId: z.string(),
});

export const OrganizationMemberRecord = z.object({
  id: z.string(),
  userId: z.string(),
  role: OrganizationRole,
  user: UserRecord,
});
export type OrganizationMemberRecord = z.infer<typeof OrganizationMemberRecord>;

export const OrganizationInviteRecord = z.object({
  id: z.string(),
  email: z.string().email(),
  role: OrganizationRole,
  organization: OrganizationRecord.optional(),
  invitedBy: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string().email().optional(),
  }),
});
export type OrganizationInviteRecord = z.infer<typeof OrganizationInviteRecord>;

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

export const CreateClientInput = z.object({
  clientName: z.string().min(1),
  redirectURIs: z.array(z.url()).min(1),
});
export type CreateClientInput = z.infer<typeof CreateClientInput>;

export const OAuthClientRecord = z.object({
  clientId: z.string(),
  clientName: z.string(),
  clientSecret: z.string(),
  redirectURIs: z.array(z.url()),
});
export type OAuthClientRecord = z.infer<typeof OAuthClientRecord>;

export const OrgInput = z.object({
  organizationSlug: z.string().min(1),
});
export type OrgInput = z.infer<typeof OrgInput>;

export const ProjectInput = z.object({
  projectSlug: z.string().min(1),
});
export type ProjectInput = z.infer<typeof ProjectInput>;

export const InternalVerifiedUserInput = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  image: z.string().nullable().optional(),
});
export type InternalVerifiedUserInput = z.infer<typeof InternalVerifiedUserInput>;

export const InternalCreateOrganizationForUserInput = z.object({
  userId: z.string(),
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(50).optional(),
});
export type InternalCreateOrganizationForUserInput = z.infer<
  typeof InternalCreateOrganizationForUserInput
>;

export const InternalCreateProjectForOrganizationInput = z.object({
  id: CallerManagedProjectId.optional(),
  organizationSlug: z.string().min(1),
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(50).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type InternalCreateProjectForOrganizationInput = z.infer<
  typeof InternalCreateProjectForOrganizationInput
>;

export const InternalProjectIngressExchangeInput = z.object({
  token: z.string().min(1),
});
export type InternalProjectIngressExchangeInput = z.infer<
  typeof InternalProjectIngressExchangeInput
>;

export const InternalEnsureOAuthClientInput = z.object({
  referenceId: z.string().min(1),
  clientName: z.string().min(1),
  redirectURIs: z.array(z.url()).min(1),
  existingClientId: z.string().min(1).optional(),
  existingClientSecret: z.string().min(1).optional(),
  rotateClientSecret: z.boolean().optional(),
});
export type InternalEnsureOAuthClientInput = z.infer<typeof InternalEnsureOAuthClientInput>;

export const InternalSetOAuthClientInput = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(16),
  clientName: z.string().min(1),
  redirectURIs: z.array(z.url()).min(1),
  referenceId: z.string().min(1).optional(),
  skipConsent: z.boolean().optional(),
});
export type InternalSetOAuthClientInput = z.infer<typeof InternalSetOAuthClientInput>;

export const InternalIntrospectOAuthAccessTokenInput = z.object({
  token: z.string().min(1),
  audiences: z.array(z.string().min(1)).min(1),
});
export type InternalIntrospectOAuthAccessTokenInput = z.infer<
  typeof InternalIntrospectOAuthAccessTokenInput
>;

export const InternalIntrospectOAuthAccessTokenOutput = z.discriminatedUnion("active", [
  z.object({
    active: z.literal(false),
    reason: z.string().optional(),
  }),
  z.object({
    active: z.literal(true),
    sub: z.string(),
    sid: z.string().optional(),
    clientId: z.string(),
    iss: z.string(),
    aud: z.union([z.string(), z.array(z.string())]),
    iat: z.number(),
    exp: z.number(),
    scope: z.string(),
    scopes: z.array(z.string()),
    organizations: z.array(AccessTokenOrganizationClaim),
    projects: z.array(AccessTokenProjectClaim),
    isAdmin: z.boolean(),
    role: z.string().nullable(),
  }),
]);
export type InternalIntrospectOAuthAccessTokenOutput = z.infer<
  typeof InternalIntrospectOAuthAccessTokenOutput
>;

export const OAuthProjectSelectionInput = z.object({
  clientId: z.string().min(1),
  projectIds: z.array(z.string().min(1)).min(1),
});
export type OAuthProjectSelectionInput = z.infer<typeof OAuthProjectSelectionInput>;

export const authContract = oc.router({
  user: {
    me: oc
      .route({
        method: "GET",
        path: "/user/me",
        summary: "Get the current authenticated user",
        tags: ["user"],
      })
      .output(UserRecord),
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
    update: oc
      .route({
        method: "POST",
        path: "/organization/update",
        summary: "Update an organization",
        tags: ["organization"],
      })
      .input(
        z.object({
          ...OrgInput.shape,
          name: z.string().min(1).max(100),
        }),
      )
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
    bySlug: oc
      .route({
        method: "GET",
        path: "/organization/by-slug",
        summary: "Get an organization by slug",
        tags: ["organization"],
      })
      .input(OrgInput)
      .output(OrganizationSummary),
    members: oc
      .route({
        method: "GET",
        path: "/organization/members",
        summary: "List members for an organization",
        tags: ["organization"],
      })
      .input(OrgInput)
      .output(z.array(OrganizationMemberRecord)),
    updateMemberRole: oc
      .route({
        method: "POST",
        path: "/organization/update-member-role",
        summary: "Update a member role in an organization",
        tags: ["organization"],
      })
      .input(
        z.object({
          ...OrgInput.shape,
          userId: z.string(),
          role: OrganizationRole,
        }),
      )
      .output(z.object({ success: z.literal(true) })),
    removeMember: oc
      .route({
        method: "POST",
        path: "/organization/remove-member",
        summary: "Remove a member from an organization",
        tags: ["organization"],
      })
      .input(
        z.object({
          ...OrgInput.shape,
          userId: z.string(),
        }),
      )
      .output(z.object({ success: z.literal(true) })),
    createInvite: oc
      .route({
        method: "POST",
        path: "/organization/create-invite",
        summary: "Invite a user to an organization",
        tags: ["organization"],
      })
      .input(
        z.object({
          ...OrgInput.shape,
          email: z.string().email(),
          role: OrganizationRole.optional(),
        }),
      )
      .output(OrganizationInviteRecord),
    listInvites: oc
      .route({
        method: "GET",
        path: "/organization/list-invites",
        summary: "List pending invites for an organization",
        tags: ["organization"],
      })
      .input(OrgInput)
      .output(z.array(OrganizationInviteRecord)),
    cancelInvite: oc
      .route({
        method: "POST",
        path: "/organization/cancel-invite",
        summary: "Cancel a pending organization invite",
        tags: ["organization"],
      })
      .input(
        z.object({
          ...OrgInput.shape,
          inviteId: z.string(),
        }),
      )
      .output(z.object({ success: z.literal(true) })),
    myPendingInvites: oc
      .route({
        method: "GET",
        path: "/organization/my-pending-invites",
        summary: "List invites for the current authenticated user",
        tags: ["organization"],
      })
      .output(z.array(OrganizationInviteRecord)),
    acceptInvite: oc
      .route({
        method: "POST",
        path: "/organization/accept-invite",
        summary: "Accept an organization invite",
        tags: ["organization"],
      })
      .input(z.object({ inviteId: z.string() }))
      .output(OrganizationRecord),
    declineInvite: oc
      .route({
        method: "POST",
        path: "/organization/decline-invite",
        summary: "Decline an organization invite",
        tags: ["organization"],
      })
      .input(z.object({ inviteId: z.string() }))
      .output(z.object({ success: z.literal(true) })),
    leave: oc
      .route({
        method: "POST",
        path: "/organization/leave",
        summary: "Leave an organization",
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
    bySlug: oc
      .route({
        method: "GET",
        path: "/project/by-slug",
        summary: "Get a project container by slug",
        tags: ["project"],
      })
      .input(ProjectInput)
      .output(ProjectRecord),
    create: oc
      .route({
        method: "POST",
        path: "/project/create",
        summary: "Create a project container",
        tags: ["project"],
      })
      .input(
        z.object({
          id: CallerManagedProjectId.optional(),
          ...OrgInput.shape,
          name: z.string().min(1).max(100),
          slug: z.string().min(1).max(50).optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .output(ProjectRecord),
    update: oc
      .route({
        method: "POST",
        path: "/project/update",
        summary: "Update a project container",
        tags: ["project"],
      })
      .input(
        z.object({
          ...ProjectInput.shape,
          name: z.string().min(1).max(100).optional(),
          slug: z.string().min(1).max(50).optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
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
      introspectAccessToken: oc
        .route({
          method: "POST",
          path: "/internal/oauth/introspect-access-token",
          summary: "Introspect an OAuth access token for internal resource servers",
          tags: ["internal", "oauth"],
        })
        .input(InternalIntrospectOAuthAccessTokenInput)
        .output(InternalIntrospectOAuthAccessTokenOutput),
    },
    user: {
      upsertVerifiedEmail: oc
        .route({
          method: "POST",
          path: "/internal/user/upsert-verified-email",
          summary: "Create or update a verified user for internal service flows",
          tags: ["internal", "user"],
        })
        .input(InternalVerifiedUserInput)
        .output(UserRecord),
    },
    organization: {
      createForUser: oc
        .route({
          method: "POST",
          path: "/internal/organization/create-for-user",
          summary: "Create an organization and owner membership for a specific user",
          tags: ["internal", "organization"],
        })
        .input(InternalCreateOrganizationForUserInput)
        .output(OrganizationRecord),
      members: oc
        .route({
          method: "GET",
          path: "/internal/organization/members",
          summary: "List organization members for internal service flows",
          tags: ["internal", "organization"],
        })
        .input(OrgInput)
        .output(z.array(OrganizationMemberRecord)),
    },
    project: {
      createForOrganization: oc
        .route({
          method: "POST",
          path: "/internal/project/create-for-organization",
          summary: "Create a project for an organization in internal service flows",
          tags: ["internal", "project"],
        })
        .input(InternalCreateProjectForOrganizationInput)
        .output(ProjectRecord),
      mintProjectId: oc
        .route({
          method: "POST",
          path: "/internal/project/mint-project-id",
          summary:
            "Mint a canonical project id (prj_) without creating an auth-side project — for OS operator/recovery creates with no owning organization",
          tags: ["internal", "project"],
        })
        .output(z.object({ id: z.string() })),
    },
    session: {
      createProjectIngressToken: oc
        .route({
          method: "GET",
          path: "/internal/session/create-project-ingress-token",
          summary: "Create a one-time project ingress token for the current authenticated user",
          tags: ["internal", "session"],
        })
        .output(z.object({ token: z.string() })),
      exchangeProjectIngressToken: oc
        .route({
          method: "POST",
          path: "/internal/session/exchange-project-ingress-token",
          summary:
            "Exchange a one-time project ingress token for a custom-domain ingress bearer token",
          tags: ["internal", "session"],
        })
        .input(InternalProjectIngressExchangeInput)
        .output(
          z.object({
            token: z.string(),
            user: UserRecord,
          }),
        ),
    },
  },
});
export type AuthContractClient = ContractRouterClient<typeof authContract>;

export type AuthContractClientOptions = {
  baseUrl: string;
  serviceToken?: string;
  asUserId?: string;
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
        if (options.asUserId) {
          headers.set(AS_USER_HEADER, options.asUserId);
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
