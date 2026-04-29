import { ORPCError } from "@orpc/server";
import { typeid } from "@iterate-com/shared/typeid";
import {
  countProjects,
  deleteProject,
  getProjectById,
  insertProject,
  listProjects,
  updateProjectConfig,
} from "~/db/queries/.generated/index.ts";
import {
  isReservedProjectHostname,
  isValidCustomHostname,
  normalizeCustomHostname,
} from "~/lib/project-host-routing.ts";
import { activeOrganizationMiddleware, os } from "~/orpc/orpc.ts";

type ProjectRow = {
  id: string;
  slug: string;
  clerk_org_id?: string | null;
  created_by_clerk_user_id?: string | null;
  custom_hostname?: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
};

function toProject(row: ProjectRow) {
  return {
    id: row.id,
    slug: row.slug,
    clerkOrgId: requireProjectOwnerField(row.clerk_org_id, row.id, "clerk_org_id"),
    createdByClerkUserId: requireProjectOwnerField(
      row.created_by_clerk_user_id,
      row.id,
      "created_by_clerk_user_id",
    ),
    customHostname: row.custom_hostname ?? null,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireProjectOwnerField(
  value: string | null | undefined,
  projectId: string,
  field: string,
) {
  if (!value) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: `Project ${projectId} is missing ${field}`,
    });
  }

  return value;
}

function normalizeConfigCustomHostname(
  input: string | null | undefined,
  projectHostnameBases: readonly string[],
) {
  if (input === undefined) return undefined;

  const customHostname = normalizeCustomHostname(input);
  if (customHostname === null) return null;

  if (!isValidCustomHostname(customHostname)) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Custom hostname must be a valid DNS hostname.",
    });
  }

  if (isReservedProjectHostname(customHostname, projectHostnameBases)) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Custom hostname cannot use a reserved OS project hostname.",
    });
  }

  return customHostname;
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}

export const projectsRouter = {
  projects: {
    create: os.projects.create
      .use(activeOrganizationMiddleware)
      .handler(async ({ context, input }) => {
        const auth = context.activeOrganization;
        const id = typeid({
          env: { TYPEID_PREFIX: context.config.typeIdPrefix.exposeSecret() },
          prefix: "proj",
        });

        try {
          const row = await insertProject(context.db, {
            id,
            slug: input.slug,
            clerkOrgId: auth.orgId,
            createdByClerkUserId: auth.userId,
            metadata: JSON.stringify(input.metadata),
          });

          if (!row) {
            throw new ORPCError("INTERNAL_SERVER_ERROR", {
              message: `Project ${id} was not returned after insert`,
            });
          }

          return toProject(row);
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            throw new ORPCError("CONFLICT", {
              message: `A project with slug ${input.slug} already exists.`,
            });
          }

          throw error;
        }
      }),
    list: os.projects.list.use(activeOrganizationMiddleware).handler(async ({ context, input }) => {
      const auth = context.activeOrganization;
      const [totalRow, rows] = await Promise.all([
        countProjects(context.db, { clerkOrgId: auth.orgId }),
        listProjects(context.db, {
          clerkOrgId: auth.orgId,
          limit: input.limit,
          offset: input.offset,
        }),
      ]);

      return { projects: rows.map(toProject), total: totalRow?.total ?? 0 };
    }),
    find: os.projects.find.use(activeOrganizationMiddleware).handler(async ({ context, input }) => {
      const auth = context.activeOrganization;
      const row = await getProjectById(context.db, { clerkOrgId: auth.orgId, id: input.id });

      if (!row) {
        throw new ORPCError("NOT_FOUND", { message: `Project ${input.id} not found` });
      }

      return toProject(row);
    }),
    updateConfig: os.projects.updateConfig
      .use(activeOrganizationMiddleware)
      .handler(async ({ context, input }) => {
        const auth = context.activeOrganization;
        const existing = await getProjectById(context.db, {
          clerkOrgId: auth.orgId,
          id: input.id,
        });

        if (!existing) {
          throw new ORPCError("NOT_FOUND", { message: `Project ${input.id} not found` });
        }

        const normalizedCustomHostname = normalizeConfigCustomHostname(
          input.customHostname,
          context.projectHostnameBases,
        );
        const nextCustomHostname =
          normalizedCustomHostname === undefined
            ? (existing.custom_hostname ?? null)
            : normalizedCustomHostname;
        const nextMetadata =
          input.metadata ?? (JSON.parse(existing.metadata) as Record<string, unknown>);

        try {
          await updateProjectConfig(
            context.db,
            {
              customHostname: nextCustomHostname,
              metadata: JSON.stringify(nextMetadata),
            },
            { clerkOrgId: auth.orgId, id: input.id },
          );
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            throw new ORPCError("CONFLICT", {
              message: `Custom hostname ${nextCustomHostname} is already assigned.`,
            });
          }

          throw error;
        }

        const row = await getProjectById(context.db, { clerkOrgId: auth.orgId, id: input.id });
        if (!row) {
          throw new ORPCError("INTERNAL_SERVER_ERROR", {
            message: `Project ${input.id} was not returned after update`,
          });
        }

        return toProject(row);
      }),
    remove: os.projects.remove
      .use(activeOrganizationMiddleware)
      .handler(async ({ context, input }) => {
        const auth = context.activeOrganization;
        const existing = await getProjectById(context.db, { clerkOrgId: auth.orgId, id: input.id });

        if (!existing) {
          return { ok: true as const, id: input.id, deleted: false };
        }

        await deleteProject(context.db, { clerkOrgId: auth.orgId, id: input.id });
        return { ok: true as const, id: input.id, deleted: true };
      }),
  },
};
