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
});
export type InternalEnsureOAuthClientInput = z.infer<typeof InternalEnsureOAuthClientInput>;

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
  superadmin: {
    oauth: {
      createClient: oc
        .route({
          method: "POST",
          path: "/superadmin/oauth/create-client",
          summary: "Create a new OAuth client",
          tags: ["superadmin", "oauth"],
        })
        .input(CreateClientInput)
        .output(OAuthClientRecord),
      listClients: oc
        .route({
          method: "GET",
          path: "/superadmin/oauth/list-clients",
          summary: "List all OAuth clients",
          tags: ["superadmin", "oauth"],
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
