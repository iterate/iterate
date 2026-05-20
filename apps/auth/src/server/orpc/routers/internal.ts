import { ORPCError } from "@orpc/server";
import { resolveUniqueSlug } from "@iterate-com/shared/slug";
import { os, protectedMiddleware, serviceMiddleware } from "../orpc.ts";
import { auth, createProjectIngressToken as createSignedProjectIngressToken } from "../../auth.ts";
import { parseStringArray } from "../../db/helpers.ts";
import {
  disableOAuthClientById,
  getOAuthClientByClientId,
  getOAuthClientByReferenceId,
  getOrganizationBySlug,
  getProjectById,
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
import { BOOTSTRAP_SUPERADMIN_EMAIL } from "../../bootstrap-superadmin.ts";
import {
  generateId,
  toMembershipRole,
  toOrganizationRecord,
  toProjectRecordFromReturnedRow,
  toUserRecord,
} from "./_shared.ts";

function extractCookieHeader(setCookieHeader: string | null): string | null {
  if (!setCookieHeader) return null;
  const firstCookie = setCookieHeader.split(/,(?=[^;]+=[^;]+)/)[0]?.trim();
  if (!firstCookie) return null;
  return firstCookie.split(";")[0] ?? null;
}

async function getBootstrapSuperadminAuthHeaders(params: {
  serviceAuthToken: string;
}): Promise<Headers> {
  const signInResult = await auth.api.signInEmail({
    returnHeaders: true,
    body: {
      email: BOOTSTRAP_SUPERADMIN_EMAIL,
      password: params.serviceAuthToken,
    },
  });

  const cookie = extractCookieHeader(signInResult.headers.get("set-cookie"));
  if (!cookie) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Failed to establish bootstrap superadmin auth session",
    });
  }

  return new Headers({ cookie });
}

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

    const projectId = input.id ?? generateId("prj");
    if (input.id && (await getProjectById(context.db, { id: input.id }))) {
      throw new ORPCError("CONFLICT", { message: "Project ID already exists" });
    }

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

    return toProjectRecordFromReturnedRow(created);
  });

const ensureOAuthClient = os.internal.oauth.ensureClient
  .use(serviceMiddleware)
  .handler(async ({ context, input }) => {
    const redirectURIs = [...new Set(input.redirectURIs.map((uri) => uri.trim()))].sort();
    const existingByReferenceId = await getOAuthClientByReferenceId(context.db, {
      referenceId: input.referenceId,
    });
    const existingByClientId = input.existingClientId
      ? await getOAuthClientByClientId(context.db, {
          clientId: input.existingClientId,
        })
      : null;
    const shouldRotateDevClient = input.referenceId.startsWith("dev:");

    const existing =
      shouldRotateDevClient && existingByClientId?.clientSecret
        ? existingByClientId
        : existingByReferenceId;

    const shouldCreateFreshClient = input.rotateClientSecret || !input.existingClientSecret;

    if (existing?.clientSecret && !shouldRotateDevClient && !shouldCreateFreshClient) {
      const existingClientSecret = input.existingClientSecret;
      if (!existingClientSecret) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: "Existing OAuth client secret is required.",
        });
      }

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
        clientSecret: existingClientSecret,
        redirectURIs: redirectURIs,
      };
    }

    if (existing?.clientSecret && !shouldRotateDevClient && shouldCreateFreshClient) {
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

    if (
      shouldRotateDevClient &&
      existingByClientId?.clientSecret &&
      existingByReferenceId &&
      existingByReferenceId.id !== existingByClientId.id
    ) {
      await disableOAuthClientById(
        context.db,
        {
          updatedAt: Date.now(),
        },
        {
          id: existingByReferenceId.id,
        },
      );
    }

    if (shouldRotateDevClient && existingByClientId?.clientSecret && !shouldCreateFreshClient) {
      const existingClientSecret = input.existingClientSecret;
      if (!existingClientSecret) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: "Existing OAuth client secret is required.",
        });
      }

      const existingSorted = parseStringArray(existingByClientId.redirectUrisJson).sort();
      const needsUpdate =
        existingByClientId.name !== input.clientName ||
        existingByClientId.disabled !== 0 ||
        existingByClientId.referenceId !== input.referenceId ||
        JSON.stringify(existingSorted) !== JSON.stringify(redirectURIs);

      if (needsUpdate) {
        await updateOAuthClientReferenceByClientId(
          context.db,
          {
            referenceId: input.referenceId,
            name: input.clientName,
            redirectUris: JSON.stringify(redirectURIs),
            updatedAt: Date.now(),
          },
          {
            clientId: existingByClientId.clientId,
          },
        );
      }

      return {
        clientId: existingByClientId.clientId,
        clientName: input.clientName,
        clientSecret: existingClientSecret,
        redirectURIs,
      };
    }

    if (existingByReferenceId && shouldRotateDevClient) {
      await disableOAuthClientById(
        context.db,
        {
          updatedAt: Date.now(),
        },
        {
          id: existingByReferenceId.id,
        },
      );
    }

    if (existingByClientId && existingByClientId.id !== existingByReferenceId?.id) {
      await disableOAuthClientById(
        context.db,
        {
          updatedAt: Date.now(),
        },
        {
          id: existingByClientId.id,
        },
      );
    }

    const serviceAuthToken = context.env.SERVICE_AUTH_TOKEN?.trim();
    if (!serviceAuthToken) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: "SERVICE_AUTH_TOKEN is required for bootstrap OAuth client provisioning",
      });
    }

    const headers = await getBootstrapSuperadminAuthHeaders({
      serviceAuthToken,
    });
    const created = await auth.api.adminCreateOAuthClient({
      headers,
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
