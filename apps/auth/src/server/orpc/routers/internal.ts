import { ORPCError } from "@orpc/server";
import { resolveUniqueSlug } from "@iterate-com/shared/slug";
import { os, protectedMiddleware, serviceMiddleware } from "../orpc.ts";
import { auth, createProjectIngressToken as createSignedProjectIngressToken } from "../../auth.ts";
import { parseProjectMetadata, parseStringArray } from "../../db/helpers.ts";
import {
  countProjects,
  disableOAuthClientById,
  getOAuthClientByClientId,
  getOAuthClientByReferenceId,
  getOrganizationBySlug,
  getProjectWithOrganizationBySlug,
  getUserByEmail,
  getUserById,
  insertMembership,
  insertOrganization,
  insertProjectReturning,
  insertUser,
  listAllProjectsWithOrganization,
  listMembersByOrganizationId,
  overwriteOAuthClientByClientId,
  updateOAuthClientById,
  updateOAuthClientReferenceByClientId,
  updateVerifiedUserById,
} from "../../db/queries/index.ts";
import { BOOTSTRAP_ADMIN_EMAIL } from "../../bootstrap-admin.ts";
import {
  generateId,
  toMembershipRole,
  toOrganizationRecord,
  toProjectRecord,
  toProjectRecordFromReturnedRow,
  toUserRecord,
} from "./_shared.ts";
import { resolveProjectCreateTarget } from "./project-slugs.ts";

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

// Auth is the canonical minter of the prj_ id space. OS calls this for the
// operator/recovery create path (no owning organization), so even org-less
// projects get auth-minted ids and OS never mints locally.
const mintProjectId = os.internal.project.mintProjectId
  .use(serviceMiddleware)
  .handler(async () => ({ id: generateId("prj") }));

// Plain slug lookup for trusted service flows: OS ingress resolves project
// platform hosts (<slug>.<base>) to project ids here, and OS server reads use
// it for the stale-claims window right after a create. The service token is
// fully trusted, so there is no user scoping — callers enforce their own
// authorization (OS checks the reader's org membership; ingress only maps
// slug -> id).
const projectBySlug = os.internal.project.bySlug
  .use(serviceMiddleware)
  .handler(async ({ context, input }) => {
    const projectRow = await getProjectWithOrganizationBySlug(context.db, {
      slug: input.projectSlug,
    });
    if (!projectRow) return null;
    return toProjectRecord({
      id: projectRow.id,
      organizationId: projectRow.organizationId,
      name: projectRow.name,
      slug: projectRow.slug,
      metadata: parseProjectMetadata(projectRow.metadata),
      archivedAt:
        typeof projectRow.archivedAt === "number" ? new Date(projectRow.archivedAt) : null,
    });
  });

// Deployment-wide project inventory for the OS admin page. Auth is the source
// of truth for which projects exist; OS overlays per-deployment engine state on
// top of this list. The service token is fully trusted — OS guards its own
// admin surface before calling.
const listAllProjects = os.internal.project.listAll
  .use(serviceMiddleware)
  .handler(async ({ context, input }) => {
    const limit = input.limit ?? 100;
    const offset = input.offset ?? 0;
    const [rows, count] = await Promise.all([
      listAllProjectsWithOrganization(context.db, { limit, offset }),
      countProjects(context.db),
    ]);
    return {
      projects: rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        organizationId: row.organizationId,
        organizationName: row.organizationName,
        archivedAt:
          typeof row.archivedAt === "number" ? new Date(row.archivedAt).toISOString() : null,
        createdAt: new Date(row.createdAt).toISOString(),
        updatedAt: new Date(row.updatedAt).toISOString(),
      })),
      total: count?.total ?? 0,
    };
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

    const target = await resolveProjectCreateTarget({
      db: context.db,
      id: input.id,
      name: input.name,
      organizationId: organization.id,
      slug: input.slug,
    });
    if (target.kind === "existing") {
      return toProjectRecordFromReturnedRow(target.project);
    }

    const projectId = input.id ?? generateId("prj");

    const now = Date.now();
    const created = await insertProjectReturning(context.db, {
      id: projectId,
      organizationId: organization.id,
      name: input.name,
      slug: target.slug,
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

    const serviceAuthToken = context.env.SERVICE_AUTH_TOKEN?.trim();
    if (!serviceAuthToken) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: "SERVICE_AUTH_TOKEN is required for bootstrap OAuth client provisioning",
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

// The oauth-provider plugin stores client secrets as unsalted SHA-256
// base64url (its `defaultHasher` with storeClientSecret: "hashed") and
// compares hashes at the token endpoint — seeded secrets must be stored in
// the same format.
async function hashOAuthClientSecret(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

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
      clientSecret: await hashOAuthClientSecret(input.clientSecret),
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
      const serviceAuthToken = context.env.SERVICE_AUTH_TOKEN?.trim();
      if (!serviceAuthToken) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: "SERVICE_AUTH_TOKEN is required for OAuth client provisioning",
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
    createForUser,
    members,
  },
  project: {
    bySlug: projectBySlug,
    createForOrganization,
    listAll: listAllProjects,
    mintProjectId,
  },
  session: {
    createProjectIngressToken,
    exchangeProjectIngressToken,
  },
});
