import { ORPCError } from "@orpc/server";
import { EventInput, StreamPath } from "@iterate-com/shared/streams/types";
import type { D1ObjectCatalogRecord } from "@iterate-com/shared/durable-object-utils/mixins/with-d1-object-catalog";
import {
  getD1ObjectCatalogRecord,
  listD1ObjectCatalogRecordsByIndex,
} from "@iterate-com/shared/durable-object-utils/mixins/with-d1-object-catalog";
import { typeid } from "@iterate-com/shared/typeid";
import type { AppContext } from "~/context.ts";
import {
  countProjects,
  deleteProject,
  deleteProjectPreset,
  getProjectPresetById,
  getProjectById,
  getProjectBySlug,
  insertProjectPreset,
  listProjectPresets,
  listProjects,
  updateProjectPreset,
  updateProjectConfig,
} from "~/db/queries/.generated/index.ts";
import type { CodemodeSessionInitParams } from "~/durable-objects/codemode-session.ts";
import type { ProjectDurableObject } from "~/durable-objects/project-durable-object.ts";
import type { ProjectMcpServerConnectionInitParams } from "~/durable-objects/project-mcp-server-connection.ts";
import {
  isReservedProjectHostname,
  isValidCustomHostname,
  normalizeCustomHostname,
} from "~/lib/project-host-routing.ts";
import type { ActiveOrganizationAuth } from "~/lib/active-organization-auth.ts";
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

type ProjectPresetRow = {
  id: string;
  project_id: string;
  name: string;
  description?: string | null;
  events_json: string;
  created_at: string;
  updated_at: string;
};

type CodemodeSessionCatalogRecord = D1ObjectCatalogRecord<CodemodeSessionInitParams>;
type InboundMcpSessionCatalogRecord = D1ObjectCatalogRecord<ProjectMcpServerConnectionInitParams>;

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

function toProjectPreset(row: ProjectPresetRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description ?? null,
    events: EventInput.array().parse(JSON.parse(row.events_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toCodemodeSession(record: CodemodeSessionCatalogRecord) {
  return {
    name: record.name,
    projectId: record.initParams.projectId,
    streamPath: StreamPath.parse(record.initParams.streamPath),
    createdAt: record.createdAt,
    lastWokenAt: record.lastWokenAt,
  };
}

function toInboundMcpSession(record: InboundMcpSessionCatalogRecord) {
  return {
    name: record.name,
    projectId: record.initParams.projectId,
    projectSlug: record.initParams.projectSlug,
    streamPath: StreamPath.parse(record.initParams.streamPath),
    clientId: record.initParams.clientId,
    clientName: record.initParams.clientName,
    userId: record.initParams.userId,
    createdAt: record.createdAt,
    lastWokenAt: record.lastWokenAt,
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

        let project: Awaited<ReturnType<ProjectDurableObject["createProject"]>>;

        try {
          project = await requireProjectDurableObjectNamespace(context)
            .getByName(id)
            .createProject({
              projectId: id,
              slug: input.slug,
              clerkOrgId: auth.orgId,
              createdByClerkUserId: auth.userId,
              metadata: input.metadata,
            });
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            throw new ORPCError("CONFLICT", {
              message: `A project with slug ${input.slug} already exists.`,
            });
          }

          throw error;
        }

        const row = await getProjectById(context.db, { clerkOrgId: auth.orgId, id: project.id });
        if (!row) {
          throw new ORPCError("INTERNAL_SERVER_ERROR", {
            message: `Project ${id} was not returned after createProject`,
          });
        }

        return toProject(row);
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
    findBySlug: os.projects.findBySlug
      .use(activeOrganizationMiddleware)
      .handler(async ({ context, input }) => {
        const auth = context.activeOrganization;
        const row = await getProjectBySlug(context.db, {
          clerkOrgId: auth.orgId,
          slug: input.slug,
        });

        if (!row) {
          throw new ORPCError("NOT_FOUND", { message: `Project ${input.slug} not found` });
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
    codemodeSessions: {
      list: os.projects.codemodeSessions.list
        .use(activeOrganizationMiddleware)
        .handler(async ({ context, input }) => {
          await requireProject({
            activeOrganization: context.activeOrganization,
            context,
            projectId: input.projectId,
          });
          const rows = await listD1ObjectCatalogRecordsByIndex<CodemodeSessionInitParams>(
            requireD1ObjectCatalog(context),
            {
              className: "CodemodeSession",
              indexName: "projectId",
              indexValue: input.projectId,
            },
          );

          return { sessions: rows.map(toCodemodeSession) };
        }),
      find: os.projects.codemodeSessions.find
        .use(activeOrganizationMiddleware)
        .handler(async ({ context, input }) => {
          await requireProject({
            activeOrganization: context.activeOrganization,
            context,
            projectId: input.projectId,
          });
          const record = await getD1ObjectCatalogRecord<CodemodeSessionInitParams>(
            requireD1ObjectCatalog(context),
            {
              className: "CodemodeSession",
              name: input.name,
            },
          );

          if (!record || record.initParams.projectId !== input.projectId) {
            throw new ORPCError("NOT_FOUND", {
              message: `Codemode Session ${input.name} not found`,
            });
          }

          return toCodemodeSession(record);
        }),
    },
    mcpSessions: {
      list: os.projects.mcpSessions.list
        .use(activeOrganizationMiddleware)
        .handler(async ({ context, input }) => {
          await requireProject({
            activeOrganization: context.activeOrganization,
            context,
            projectId: input.projectId,
          });
          const rows =
            await listD1ObjectCatalogRecordsByIndex<ProjectMcpServerConnectionInitParams>(
              requireD1ObjectCatalog(context),
              {
                className: "ProjectMcpServerConnection",
                indexName: "projectId",
                indexValue: input.projectId,
              },
            );

          return { sessions: rows.map(toInboundMcpSession) };
        }),
    },
    presets: {
      list: os.projects.presets.list
        .use(activeOrganizationMiddleware)
        .handler(async ({ context, input }) => {
          const auth = context.activeOrganization;
          const rows = await listProjectPresets(context.db, {
            clerkOrgId: auth.orgId,
            projectId: input.projectId,
          });

          return { presets: rows.map(toProjectPreset) };
        }),
      create: os.projects.presets.create
        .use(activeOrganizationMiddleware)
        .handler(async ({ context, input }) => {
          const auth = context.activeOrganization;
          const project = await getProjectById(context.db, {
            clerkOrgId: auth.orgId,
            id: input.projectId,
          });

          if (!project) {
            throw new ORPCError("NOT_FOUND", {
              message: `Project ${input.projectId} not found`,
            });
          }

          const id = typeid({
            env: { TYPEID_PREFIX: context.config.typeIdPrefix.exposeSecret() },
            prefix: "preset",
          });

          try {
            const row = await insertProjectPreset(context.db, {
              id,
              projectId: input.projectId,
              name: input.name,
              description: input.description ?? null,
              eventsJson: JSON.stringify(input.events),
            });

            if (!row) {
              throw new ORPCError("INTERNAL_SERVER_ERROR", {
                message: `Preset ${id} was not returned after insert`,
              });
            }

            return toProjectPreset(row);
          } catch (error) {
            if (isUniqueConstraintError(error)) {
              throw new ORPCError("CONFLICT", {
                message: `A preset named ${input.name} already exists.`,
              });
            }

            throw error;
          }
        }),
      update: os.projects.presets.update
        .use(activeOrganizationMiddleware)
        .handler(async ({ context, input }) => {
          const auth = context.activeOrganization;
          const existing = await getProjectPresetById(context.db, {
            clerkOrgId: auth.orgId,
            id: input.id,
            projectId: input.projectId,
          });

          if (!existing) {
            throw new ORPCError("NOT_FOUND", {
              message: `Preset ${input.id} not found`,
            });
          }

          try {
            await updateProjectPreset(
              context.db,
              {
                name: input.name,
                description: input.description ?? null,
                eventsJson: JSON.stringify(input.events),
              },
              { clerkOrgId: auth.orgId, id: input.id, projectId: input.projectId },
            );
          } catch (error) {
            if (isUniqueConstraintError(error)) {
              throw new ORPCError("CONFLICT", {
                message: `A preset named ${input.name} already exists.`,
              });
            }

            throw error;
          }

          const row = await getProjectPresetById(context.db, {
            clerkOrgId: auth.orgId,
            id: input.id,
            projectId: input.projectId,
          });
          if (!row) {
            throw new ORPCError("INTERNAL_SERVER_ERROR", {
              message: `Preset ${input.id} was not returned after update`,
            });
          }

          return toProjectPreset(row);
        }),
      remove: os.projects.presets.remove
        .use(activeOrganizationMiddleware)
        .handler(async ({ context, input }) => {
          const auth = context.activeOrganization;
          const existing = await getProjectPresetById(context.db, {
            clerkOrgId: auth.orgId,
            id: input.id,
            projectId: input.projectId,
          });

          if (!existing) {
            return { ok: true as const, id: input.id, deleted: false };
          }

          await deleteProjectPreset(context.db, {
            clerkOrgId: auth.orgId,
            id: input.id,
            projectId: input.projectId,
          });

          return { ok: true as const, id: input.id, deleted: true };
        }),
    },
  },
};

async function requireProject(input: {
  activeOrganization: ActiveOrganizationAuth;
  context: AppContext;
  projectId: string;
}) {
  const project = await getProjectById(input.context.db, {
    clerkOrgId: input.activeOrganization.orgId,
    id: input.projectId,
  });

  if (!project) {
    throw new ORPCError("NOT_FOUND", {
      message: `Project ${input.projectId} not found`,
    });
  }

  return project;
}

function requireD1ObjectCatalog(context: AppContext) {
  if (!context.doCatalog) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "DO_CATALOG binding not available.",
    });
  }

  return context.doCatalog;
}

function requireProjectDurableObjectNamespace(context: AppContext) {
  if (!context.projectDurableObjectNamespace) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "PROJECT binding not available.",
    });
  }

  return context.projectDurableObjectNamespace;
}
