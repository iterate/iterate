import { ORPCError } from "@orpc/server";
import { resolveUniqueSlug } from "@iterate-com/shared/slug";
import { os, protectedMiddleware, serviceMiddleware } from "../orpc.ts";
import { auth, createProjectIngressToken as createSignedProjectIngressToken } from "../../auth.ts";
import { parseProjectMetadata, parseStringArray } from "../../db/helpers.ts";
import {
  disableOAuthClientById,
  getOAuthClientByReferenceId,
  getOrganizationBySlug,
  getProjectBySlug,
  getUserByEmail,
  getUserById,
  insertMembership,
  insertOrganization,
  insertProjectReturning,
  insertUser,
  listMembersByOrganizationId,
  updateOAuthClientById,
  updateOAuthClientReferenceByClientId,
  updateVerifiedUserById,
} from "../../db/queries/index.ts";
import {
  generateId,
  toMembershipRole,
  toOrganizationRecord,
  toProjectRecord,
  toUserRecord,
} from "./_shared.ts";

const upsertVerifiedEmail = os.internal.user.upsertVerifiedEmail
  .use(serviceMiddleware)
  .handler(async ({ context, input }) => {
    const normalizedEmail = input.email.trim().toLowerCase();
    const existing = await getUserByEmail(context.db, { email: normalizedEmail });

    if (existing) {
      await updateVerifiedUserById(
        context.db,
        {
          name: input.name,
          image: input.image ?? existing.image ?? null,
          updatedAt: Date.now(),
        },
        {
          id: existing.id,
        },
      );

      return toUserRecord({
        ...existing,
        name: input.name,
        image: input.image ?? existing.image ?? null,
      });
    }

    const id = generateId("usr");
    const now = Date.now();
    await insertUser(context.db, {
      id,
      name: input.name,
      email: normalizedEmail,
      emailVerified: 1,
      image: input.image ?? null,
      role: "user",
      createdAt: now,
      updatedAt: now,
    });

    return toUserRecord({
      id,
      name: input.name,
      email: normalizedEmail,
      image: input.image ?? null,
      role: "user",
    });
  });

const createForUser = os.internal.organization.createForUser
  .use(serviceMiddleware)
  .handler(async ({ context, input }) => {
    const user = await getUserById(context.db, { id: input.userId });
    if (!user) {
      throw new ORPCError("NOT_FOUND", { message: "User not found" });
    }

    const slug = await resolveUniqueSlug({
      name: input.name,
      slug: input.slug,
      isTaken: async (candidate) =>
        Boolean(await getOrganizationBySlug(context.db, { slug: candidate })),
    });

    const organizationId = generateId("org");
    const now = Date.now();
    await context.db.transaction(async (tx) => {
      await insertOrganization(tx, {
        id: organizationId,
        name: input.name,
        slug,
        createdAt: now,
        metadata: null,
        logo: null,
      });

      await insertMembership(tx, {
        id: generateId("member"),
        organizationId,
        userId: input.userId,
        role: "owner",
        createdAt: now,
      });
    });

    return toOrganizationRecord({
      id: organizationId,
      name: input.name,
      slug,
    });
  });

const members = os.internal.organization.members
  .use(serviceMiddleware)
  .handler(async ({ context, input }) => {
    const organization = await getOrganizationBySlug(context.db, {
      slug: input.organizationSlug,
    });
    if (!organization) {
      throw new ORPCError("NOT_FOUND", { message: "Organization not found" });
    }

    const members = await listMembersByOrganizationId(context.db, {
      organizationId: organization.id,
    });

    return members.map((member) => ({
      id: member.id,
      userId: member.userId,
      role: toMembershipRole(member.role),
      user: toUserRecord({
        id: member.userId,
        name: member.userName,
        email: member.userEmail,
        image: member.userImage ?? null,
        role: member.userRole ?? null,
      }),
    }));
  });

const createForOrganization = os.internal.project.createForOrganization
  .use(serviceMiddleware)
  .handler(async ({ context, input }) => {
    const organization = await getOrganizationBySlug(context.db, {
      slug: input.organizationSlug,
    });
    if (!organization) {
      throw new ORPCError("NOT_FOUND", { message: "Organization not found" });
    }

    const slug = await resolveUniqueSlug({
      name: input.name,
      slug: input.slug,
      isTaken: async (candidate) =>
        Boolean(await getProjectBySlug(context.db, { slug: candidate })),
    });

    const projectId = generateId("prj");
    const now = Date.now();
    const created = await insertProjectReturning(context.db, {
      id: projectId,
      organizationId: organization.id,
      name: input.name,
      slug,
      metadata: JSON.stringify(input.metadata ?? {}),
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    return toProjectRecord({
      id: created.id,
      organizationId: created.organization_id,
      name: created.name,
      slug: created.slug,
      metadata: parseProjectMetadata(created.metadata),
      archivedAt: null,
    });
  });

const ensureOAuthClient = os.internal.oauth.ensureClient
  .use(serviceMiddleware)
  .handler(async ({ context, input }) => {
    const redirectURIs = [...new Set(input.redirectURIs.map((uri) => uri.trim()))].sort();
    const existing = await getOAuthClientByReferenceId(context.db, {
      referenceId: input.referenceId,
    });
    const shouldRotateDevClient = input.referenceId.startsWith("dev:");

    if (existing?.clientSecret && !shouldRotateDevClient) {
      const existingSorted = parseStringArray(existing.redirectUrisJson).sort();
      const needsUpdate =
        existing.name !== input.clientName ||
        existing.disabled !== 0 ||
        JSON.stringify(existingSorted) !== JSON.stringify(redirectURIs);

      if (needsUpdate) {
        await updateOAuthClientById(
          context.db,
          {
            name: input.clientName,
            redirectUris: JSON.stringify(redirectURIs),
            disabled: 0,
            updatedAt: Date.now(),
          },
          {
            id: existing.id,
          },
        );
      }

      return {
        clientId: existing.clientId,
        clientName: input.clientName,
        clientSecret: existing.clientSecret,
        redirectURIs: redirectURIs,
      };
    }

    if (existing && shouldRotateDevClient) {
      await disableOAuthClientById(
        context.db,
        {
          updatedAt: Date.now(),
        },
        {
          id: existing.id,
        },
      );
    }

    const created = await auth.api.adminCreateOAuthClient({
      body: {
        client_name: input.clientName,
        redirect_uris: redirectURIs,
      },
    });

    if (!created.client_name || !created.client_secret) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: "Failed to create OAuth client, got unexpected response from auth API",
        cause: { created },
      });
    }

    await updateOAuthClientReferenceByClientId(
      context.db,
      {
        referenceId: input.referenceId,
        name: input.clientName,
        redirectUris: JSON.stringify(redirectURIs),
        updatedAt: Date.now(),
      },
      {
        clientId: created.client_id,
      },
    );

    return {
      clientId: created.client_id,
      clientName: created.client_name,
      clientSecret: created.client_secret,
      redirectURIs: created.redirect_uris,
    };
  });

const createProjectIngressToken = os.internal.session.createProjectIngressToken
  .use(protectedMiddleware)
  .handler(async ({ context }) => {
    const ott = await auth.api.generateOneTimeToken({
      headers: context.reqHeaders,
    });
    return { token: ott.token };
  });

const exchangeProjectIngressToken = os.internal.session.exchangeProjectIngressToken
  .use(serviceMiddleware)
  .handler(async ({ input }) => {
    const verified = await auth.api.verifyOneTimeToken({
      body: {
        token: input.token,
      },
    });

    if (!verified) {
      throw new ORPCError("BAD_REQUEST", { message: "Invalid one-time token" });
    }

    const token = await createSignedProjectIngressToken({
      type: "project-ingress",
      userId: verified.user.id,
      email: verified.user.email,
      role: verified.user.role ?? null,
    });

    return {
      token,
      user: toUserRecord(verified.user),
    };
  });

export const internal = os.internal.router({
  oauth: {
    ensureClient: ensureOAuthClient,
  },
  user: {
    upsertVerifiedEmail,
  },
  organization: {
    createForUser,
    members,
  },
  project: {
    createForOrganization,
  },
  session: {
    createProjectIngressToken,
    exchangeProjectIngressToken,
  },
});
