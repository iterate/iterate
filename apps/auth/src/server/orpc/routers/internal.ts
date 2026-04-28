import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { resolveUniqueSlug } from "@iterate-com/shared/slug";
import { os, protectedMiddleware, serviceMiddleware } from "../orpc.ts";
import { auth, createProjectIngressToken as createSignedProjectIngressToken } from "../../auth.ts";
import { schema } from "../../db/index.ts";
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
    const existing = await context.db.query.user.findFirst({
      where: eq(schema.user.email, normalizedEmail),
    });

    if (existing) {
      await context.db
        .update(schema.user)
        .set({
          name: input.name,
          image: input.image ?? existing.image ?? null,
          emailVerified: true,
        })
        .where(eq(schema.user.id, existing.id));

      return toUserRecord({
        ...existing,
        name: input.name,
        image: input.image ?? existing.image ?? null,
      });
    }

    const id = generateId("usr");
    await context.db.insert(schema.user).values({
      id,
      name: input.name,
      email: normalizedEmail,
      emailVerified: true,
      image: input.image ?? null,
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
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
    const user = await context.db.query.user.findFirst({
      where: eq(schema.user.id, input.userId),
    });
    if (!user) {
      throw new ORPCError("NOT_FOUND", { message: "User not found" });
    }

    const slug = await resolveUniqueSlug({
      name: input.name,
      slug: input.slug,
      isTaken: async (candidate) =>
        Boolean(
          await context.db.query.organization.findFirst({
            where: eq(schema.organization.slug, candidate),
          }),
        ),
    });

    const organizationId = generateId("org");
    await context.db.insert(schema.organization).values({
      id: organizationId,
      name: input.name,
      slug,
      createdAt: new Date(),
      metadata: null,
      logo: null,
    });

    await context.db.insert(schema.member).values({
      id: generateId("member"),
      organizationId,
      userId: input.userId,
      role: "owner",
      createdAt: new Date(),
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
    const organization = await context.db.query.organization.findFirst({
      where: eq(schema.organization.slug, input.organizationSlug),
    });
    if (!organization) {
      throw new ORPCError("NOT_FOUND", { message: "Organization not found" });
    }

    const members = await context.db.query.member.findMany({
      where: eq(schema.member.organizationId, organization.id),
      with: {
        user: true,
      },
    });

    return members.map((member) => ({
      id: member.id,
      userId: member.userId,
      role: toMembershipRole(member.role),
      user: toUserRecord(member.user),
    }));
  });

const createForOrganization = os.internal.project.createForOrganization
  .use(serviceMiddleware)
  .handler(async ({ context, input }) => {
    const organization = await context.db.query.organization.findFirst({
      where: eq(schema.organization.slug, input.organizationSlug),
    });
    if (!organization) {
      throw new ORPCError("NOT_FOUND", { message: "Organization not found" });
    }

    const slug = await resolveUniqueSlug({
      name: input.name,
      slug: input.slug,
      isTaken: async (candidate) =>
        Boolean(
          await context.db.query.project.findFirst({
            where: eq(schema.project.slug, candidate),
          }),
        ),
    });

    const projectId = generateId("prj");
    await context.db.insert(schema.project).values({
      id: projectId,
      organizationId: organization.id,
      name: input.name,
      slug,
      metadata: input.metadata ?? {},
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return toProjectRecord({
      id: projectId,
      organizationId: organization.id,
      name: input.name,
      slug,
      metadata: input.metadata ?? {},
      archivedAt: null,
    });
  });

const ensureOAuthClient = os.internal.oauth.ensureClient
  .use(serviceMiddleware)
  .handler(async ({ context, input }) => {
    const redirectURIs = [...new Set(input.redirectURIs.map((uri) => uri.trim()))].sort();
    const existing = await context.db.query.oauthClient.findFirst({
      where: eq(schema.oauthClient.referenceId, input.referenceId),
    });
    const shouldRotateDevClient = input.referenceId.startsWith("dev:");

    if (existing?.clientSecret && !shouldRotateDevClient) {
      const existingSorted = [...(existing.redirectUris ?? [])].sort();
      const needsUpdate =
        existing.name !== input.clientName ||
        existing.disabled !== false ||
        JSON.stringify(existingSorted) !== JSON.stringify(redirectURIs);

      if (needsUpdate) {
        await context.db
          .update(schema.oauthClient)
          .set({
            name: input.clientName,
            redirectUris: redirectURIs,
            disabled: false,
            updatedAt: new Date(),
          })
          .where(eq(schema.oauthClient.id, existing.id));
      }

      return {
        clientId: existing.clientId,
        clientName: input.clientName,
        clientSecret: existing.clientSecret,
        redirectURIs: redirectURIs,
      };
    }

    if (existing && shouldRotateDevClient) {
      await context.db
        .update(schema.oauthClient)
        .set({
          referenceId: null,
          disabled: true,
          updatedAt: new Date(),
        })
        .where(eq(schema.oauthClient.id, existing.id));
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

    await context.db
      .update(schema.oauthClient)
      .set({
        referenceId: input.referenceId,
        name: input.clientName,
        redirectUris: redirectURIs,
        disabled: false,
        updatedAt: new Date(),
      })
      .where(eq(schema.oauthClient.clientId, created.client_id));

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
