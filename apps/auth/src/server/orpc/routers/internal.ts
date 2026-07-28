import { ORPCError } from "@orpc/server";
import { resolveUniqueSlug } from "@iterate-com/shared/slug";
import { os, protectedMiddleware, serviceMiddleware } from "../orpc.ts";
import { auth, createProjectIngressToken as createSignedProjectIngressToken } from "../../auth.ts";
import { config } from "../../env.ts";
import { parseProjectMetadata, parseStringArray, parseTimestampMs } from "../../db/helpers.ts";
import {
  disableOAuthClientById,
  getOAuthClientByClientId,
  getOAuthClientByReferenceId,
  getOrganizationBySlug,
  getProjectWithOrganizationBySlug,
  getUserByEmail,
  getUserById,
  grantPlatformAdminByUserId,
  insertMembership,
  insertOrganization,
  insertUser,
  listMembersByOrganizationId,
  overwriteOAuthClientByClientId,
  updateOAuthClientById,
  updateOAuthClientReferenceByClientId,
  updateVerifiedUserById,
} from "../../db/queries/index.ts";
import { BOOTSTRAP_ADMIN_EMAIL } from "../../bootstrap-admin.ts";
import { generateId } from "../../id.ts";
import { hashOAuthStoredValue } from "../../oauth-storage.ts";
import { ensureOrganizationForProjectSeed } from "../../organization-seed.ts";
import { toMembershipRole, toOrganizationRecord, toUserRecord } from "./_shared.ts";

function extractCookieHeader(setCookieHeader: string | null): string | null {
  if (!setCookieHeader) return null;
  const firstCookie = setCookieHeader.split(/,(?=[^;]+=[^;]+)/)[0]?.trim();
  if (!firstCookie) return null;
  return firstCookie.split(";")[0] ?? null;
}

async function getBootstrapAdminAuthHeaders(params: {
  serviceAuthToken: string;
}): Promise<Headers> {
  const signInResult = await auth.api.signInEmail({
    returnHeaders: true,
    body: {
      email: BOOTSTRAP_ADMIN_EMAIL,
      password: params.serviceAuthToken,
    },
  });

  const cookie = extractCookieHeader(signInResult.headers.get("set-cookie"));
  if (!cookie) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Failed to establish bootstrap admin auth session",
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
      const updatedAt = Date.now();
      await updateVerifiedUserById(
        context.db,
        {
          name: input.name,
          image: input.image ?? existing.image ?? null,
          updatedAt,
        },
        {
          id: existing.id,
        },
      );
      if (input.platformAdmin === true && existing.role !== "admin") {
        await grantPlatformAdminByUserId(
          context.db,
          { updatedAt },
          {
            id: existing.id,
          },
        );
      }

      return toUserRecord({
        ...existing,
        name: input.name,
        image: input.image ?? existing.image ?? null,
        role: input.platformAdmin === true ? "admin" : existing.role,
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
      role: input.platformAdmin === true ? "admin" : "user",
      createdAt: now,
      updatedAt: now,
    });

    return toUserRecord({
      id,
      name: input.name,
      email: normalizedEmail,
      image: input.image ?? null,
      role: input.platformAdmin === true ? "admin" : "user",
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

const ensureOrganization = os.internal.organization.ensure
  .use(serviceMiddleware)
  .handler(async ({ context, input }) => {
    return await ensureOrganizationForProjectSeed(context.db, input);
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

const projectSeedSnapshot = os.internal.project.seedSnapshot
  .use(serviceMiddleware)
  .handler(async ({ context, input }) => {
    const project = await getProjectWithOrganizationBySlug(context.db, {
      slug: input.projectSlug,
    });
    if (!project) {
      throw new ORPCError("NOT_FOUND", { message: "Project not found" });
    }
    const members = await listMembersByOrganizationId(context.db, {
      organizationId: project.organizationId,
    });

    return {
      project: {
        id: project.id,
        organizationId: project.organizationId,
        name: project.name,
        slug: project.slug,
        metadata: parseProjectMetadata(project.metadata),
        archivedAt: parseTimestampMs(project.archivedAt)?.toISOString() ?? null,
      },
      organization: {
        id: project.organizationRecordId,
        name: project.organizationName,
        slug: project.organizationSlug,
      },
      members: members.map((member) => ({
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
      })),
    };
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
    const shouldRotateDevClient =
      input.referenceId.startsWith("dev:") || input.referenceId.includes(":dev_");

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

    const serviceAuthToken = config.serviceAuthToken.exposeSecret().trim();
    if (!serviceAuthToken) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: "config.serviceAuthToken is required for bootstrap OAuth client provisioning",
      });
    }

    const headers = await getBootstrapAdminAuthHeaders({
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

// Declarative upsert with caller-provided credentials. Unlike ensureClient
// (which generates/rotates secrets server-side), the caller's Doppler config is
// the source of truth: re-running with the same input is a no-op, and nothing
// in the auth app ever rotates a seeded client. Used by the OAuth client seed
// (apps/auth/scripts/seed-oauth-clients.ts) after each deploy.
const setOAuthClient = os.internal.oauth.setClient
  .use(serviceMiddleware)
  .handler(async ({ context, input }) => {
    const redirectURIs = [...new Set(input.redirectURIs.map((uri) => uri.trim()))].sort();
    const overwrite = {
      newClientId: input.clientId,
      clientSecret: await hashOAuthStoredValue(input.clientSecret),
      name: input.clientName,
      redirectUris: JSON.stringify(redirectURIs),
      referenceId: input.referenceId ?? null,
      skipConsent: input.skipConsent ? 1 : 0,
      updatedAt: Date.now(),
    };

    const existing = await getOAuthClientByClientId(context.db, { clientId: input.clientId });
    if (existing) {
      await overwriteOAuthClientByClientId(context.db, overwrite, { clientId: input.clientId });
    } else {
      // Create through the admin API so the row gets the plugin's defaults
      // (token endpoint auth method, grant/response types, …), then overwrite
      // the generated credentials with the caller-provided constants.
      const serviceAuthToken = config.serviceAuthToken.exposeSecret().trim();
      if (!serviceAuthToken) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: "config.serviceAuthToken is required for OAuth client provisioning",
        });
      }
      const headers = await getBootstrapAdminAuthHeaders({ serviceAuthToken });
      const created = await auth.api.adminCreateOAuthClient({
        headers,
        body: {
          client_name: input.clientName,
          redirect_uris: redirectURIs,
        },
      });
      await overwriteOAuthClientByClientId(context.db, overwrite, {
        clientId: created.client_id,
      });
    }

    return {
      clientId: input.clientId,
      clientName: input.clientName,
      clientSecret: input.clientSecret,
      redirectURIs,
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
    setClient: setOAuthClient,
  },
  user: {
    upsertVerifiedEmail,
  },
  organization: {
    ensure: ensureOrganization,
    createForUser,
    members,
  },
  project: {
    seedSnapshot: projectSeedSnapshot,
  },
  session: {
    createProjectIngressToken,
    exchangeProjectIngressToken,
  },
});
