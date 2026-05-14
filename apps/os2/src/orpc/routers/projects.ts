import { ORPCError } from "@orpc/server";
import { StreamPath } from "@iterate-com/shared/streams/types";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "@iterate-com/shared/streams/helpers";
import type { D1ObjectCatalogRecord } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import {
  getD1ObjectCatalogRecord,
  listD1ObjectCatalogRecordsByIndex,
} from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { typeid } from "@iterate-com/shared/typeid";
import type { AppContext } from "~/context.ts";
import {
  countAllProjects,
  countProjects,
  deleteProject,
  getProjectById,
  getProjectPermission,
  getProjectBySlug,
  insertProjectPermission,
  listAllProjects,
  listProjects,
  updateProjectConfig,
} from "~/db/queries/.generated/index.ts";
import type { CodemodeSessionStructuredName } from "~/domains/codemode/durable-objects/codemode-session.ts";
import {
  getProjectDurableObjectName,
  type ProjectDurableObject,
} from "~/domains/projects/durable-objects/project-durable-object.ts";
import type { ProjectMcpServerConnectionStructuredName } from "~/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts";
import {
  PROJECT_LIFECYCLE_STREAM_PATH,
  PROJECT_SETTINGS_UPDATED_EVENT_TYPE,
} from "~/domains/projects/stream-processors/project-lifecycle.ts";
import {
  isReservedProjectHostname,
  isValidCustomHostname,
  normalizeCustomHostname,
} from "~/lib/project-host-routing.ts";
import type { ActiveOrganizationAuth } from "~/lib/active-organization-auth.ts";
import { activeOrganizationMiddleware, os, projectScopeMiddleware } from "~/orpc/orpc.ts";
import { requireProjectScope } from "~/orpc/project-access.ts";
import { projectCodemodeRouter } from "~/orpc/routers/codemode.ts";
import { projectAgentsRouter } from "~/orpc/routers/agents.ts";
import { projectReposRouter } from "~/orpc/routers/repos.ts";
import { projectIntegrationsRouter } from "~/orpc/routers/integrations.ts";
import { projectSecretsRouter } from "~/orpc/routers/secrets.ts";
import { projectStreamsRouter } from "~/orpc/routers/streams.ts";

type ProjectRow = {
  id: string;
  slug: string;
  custom_hostname?: string | null;
  external_egress_proxy?: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
};

type CodemodeSessionCatalogRecord = D1ObjectCatalogRecord<CodemodeSessionStructuredName>;
type InboundMcpSessionCatalogRecord =
  D1ObjectCatalogRecord<ProjectMcpServerConnectionStructuredName>;

function toProject(row: ProjectRow) {
  return {
    id: row.id,
    slug: row.slug,
    customHostname: row.custom_hostname ?? null,
    externalEgressProxy: row.external_egress_proxy ?? null,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toCodemodeSession(record: CodemodeSessionCatalogRecord) {
  return {
    name: record.name,
    projectId: record.structuredName.projectId,
    streamPath: StreamPath.parse(record.structuredName.streamPath),
    createdAt: record.createdAt,
    lastWokenAt: record.lastWokenAt,
  };
}

function toInboundMcpSession(record: InboundMcpSessionCatalogRecord) {
  return {
    name: record.name,
    projectId: record.structuredName.projectId,
    projectSlug: record.structuredName.projectSlug,
    streamPath: StreamPath.parse(record.structuredName.streamPath),
    clientId: record.structuredName.clientId,
    clientName: record.structuredName.clientName,
    userId: record.structuredName.userId,
    createdAt: record.createdAt,
    lastWokenAt: record.lastWokenAt,
  };
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

function normalizeConfigExternalEgressProxy(input: string | null | undefined) {
  if (input === undefined) return undefined;
  if (input === null) return null;

  const externalEgressProxy = input.trim();
  if (externalEgressProxy === "") return null;

  try {
    return new URL(externalEgressProxy).toString();
  } catch {
    throw new ORPCError("BAD_REQUEST", {
      message: "External egress proxy must be a valid URL.",
    });
  }
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
            .getByName(getProjectDurableObjectName(id))
            .createProject({
              metadata: input.metadata,
              projectId: id,
              slug: input.slug,
            });
          if (!auth.isAdminApi) {
            await insertProjectPermission(context.db, {
              principalId: auth.orgId,
              principalType: "clerk_organization",
              projectId: id,
              role: "owner",
            });
          }
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            throw new ORPCError("CONFLICT", {
              message: `A project with slug ${input.slug} already exists.`,
            });
          }

          throw error;
        }

        const row = await getProjectById(context.db, { id: project.id });
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
        auth.isAdminApi
          ? countAllProjects(context.db)
          : countProjects(context.db, {
              principalId: auth.orgId,
              principalType: "clerk_organization",
            }),
        auth.isAdminApi
          ? listAllProjects(context.db, { limit: input.limit, offset: input.offset })
          : listProjects(context.db, {
              limit: input.limit,
              offset: input.offset,
              principalId: auth.orgId,
              principalType: "clerk_organization",
            }),
      ]);

      return { projects: rows.map(toProject), total: totalRow?.total ?? 0 };
    }),
    find: os.projects.find.use(activeOrganizationMiddleware).handler(async ({ context, input }) => {
      const row = await requireProject({
        activeOrganization: context.activeOrganization,
        context,
        projectId: input.id,
      });
      return toProject(row);
    }),
    findBySlug: os.projects.findBySlug
      .use(activeOrganizationMiddleware)
      .handler(async ({ context, input }) => {
        const row = await getProjectBySlug(context.db, { slug: input.slug });

        if (!row) {
          throw new ORPCError("NOT_FOUND", { message: `Project ${input.slug} not found` });
        }

        await requireProject({
          activeOrganization: context.activeOrganization,
          context,
          projectId: row.id,
        });
        return toProject(row);
      }),
    updateConfig: os.projects.updateConfig
      .use(activeOrganizationMiddleware)
      .handler(async ({ context, input }) => {
        const existing = await requireProject({
          activeOrganization: context.activeOrganization,
          context,
          projectId: input.id,
        });

        const normalizedCustomHostname = normalizeConfigCustomHostname(
          input.customHostname,
          context.projectHostnameBases,
        );
        const nextCustomHostname =
          normalizedCustomHostname === undefined
            ? (existing.custom_hostname ?? null)
            : normalizedCustomHostname;
        const normalizedExternalEgressProxy = normalizeConfigExternalEgressProxy(
          input.externalEgressProxy,
        );
        const nextExternalEgressProxy =
          normalizedExternalEgressProxy === undefined
            ? (existing.external_egress_proxy ?? null)
            : normalizedExternalEgressProxy;
        const nextMetadata =
          input.metadata ?? (JSON.parse(existing.metadata) as Record<string, unknown>);

        try {
          await updateProjectConfig(
            context.db,
            {
              customHostname: nextCustomHostname,
              externalEgressProxy: nextExternalEgressProxy,
              metadata: JSON.stringify(nextMetadata),
            },
            { id: input.id },
          );
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            throw new ORPCError("CONFLICT", {
              message: `Custom hostname ${nextCustomHostname} is already assigned.`,
            });
          }

          throw error;
        }

        const row = await getProjectById(context.db, { id: input.id });
        if (!row) {
          throw new ORPCError("INTERNAL_SERVER_ERROR", {
            message: `Project ${input.id} was not returned after update`,
          });
        }

        await appendProjectSettingsUpdatedEvent({
          context,
          project: row,
        });

        return toProject(row);
      }),
    remove: os.projects.remove
      .use(activeOrganizationMiddleware)
      .handler(async ({ context, input }) => {
        try {
          await requireProject({
            activeOrganization: context.activeOrganization,
            context,
            projectId: input.id,
          });
        } catch (error) {
          if (error instanceof ORPCError && error.code === "NOT_FOUND") {
            return { ok: true as const, id: input.id, deleted: false };
          }
          throw error;
        }

        await deleteProject(context.db, { id: input.id });
        const existing = await getProjectById(context.db, { id: input.id });
        if (existing) {
          return { ok: true as const, id: input.id, deleted: false };
        }
        return { ok: true as const, id: input.id, deleted: true };
      }),
  },
  project: {
    get: os.project.get.use(projectScopeMiddleware).handler(async ({ context }) => {
      const row = requireProjectScope(context);
      return toProject(row);
    }),
    lifecycleState: os.project.lifecycleState
      .use(projectScopeMiddleware)
      .handler(async ({ context }) => {
        const project = requireProjectScope(context);
        return await requireProjectDurableObjectNamespace(context)
          .getByName(getProjectDurableObjectName(project.id))
          .getProjectLifecycleRunnerState();
      }),
    codemode: {
      ...projectCodemodeRouter,
      listSessions: os.project.codemode.listSessions
        .use(projectScopeMiddleware)
        .handler(async ({ context }) => {
          const project = requireProjectScope(context);
          const rows = await listD1ObjectCatalogRecordsByIndex<CodemodeSessionStructuredName>(
            requireD1ObjectCatalog(context),
            {
              className: "CodemodeSession",
              indexName: "projectId",
              indexValue: project.id,
            },
          );

          return { sessions: rows.map(toCodemodeSession) };
        }),
      findSession: os.project.codemode.findSession
        .use(projectScopeMiddleware)
        .handler(async ({ context, input }) => {
          const project = requireProjectScope(context);
          const record = await getD1ObjectCatalogRecord<CodemodeSessionStructuredName>(
            requireD1ObjectCatalog(context),
            {
              className: "CodemodeSession",
              name: input.name,
            },
          );

          if (!record || record.structuredName.projectId !== project.id) {
            throw new ORPCError("NOT_FOUND", {
              message: `Codemode Session ${input.name} not found`,
            });
          }

          return toCodemodeSession(record);
        }),
    },
    agents: projectAgentsRouter,
    repos: projectReposRouter,
    inboundMcpServer: {
      listSessions: os.project.inboundMcpServer.listSessions
        .use(projectScopeMiddleware)
        .handler(async ({ context }) => {
          const project = requireProjectScope(context);
          const rows =
            await listD1ObjectCatalogRecordsByIndex<ProjectMcpServerConnectionStructuredName>(
              requireD1ObjectCatalog(context),
              {
                className: "ProjectMcpServerConnection",
                indexName: "projectId",
                indexValue: project.id,
              },
            );

          return { sessions: rows.map(toInboundMcpSession) };
        }),
    },
    integrations: projectIntegrationsRouter,
    secrets: projectSecretsRouter,
    streams: projectStreamsRouter,
  },
};

async function requireProject(input: {
  activeOrganization: ActiveOrganizationAuth;
  context: AppContext;
  projectId: string;
}) {
  const project = await getProjectById(input.context.db, { id: input.projectId });

  if (!project) {
    throw new ORPCError("NOT_FOUND", {
      message: `Project ${input.projectId} not found`,
    });
  }

  if (input.activeOrganization.isAdminApi) {
    return project;
  }

  const permission = await getProjectPermission(input.context.db, {
    principalId: input.activeOrganization.orgId,
    principalType: "clerk_organization",
    projectId: input.projectId,
  });
  if (!permission) {
    throw new ORPCError("FORBIDDEN", {
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

async function appendProjectSettingsUpdatedEvent(input: {
  context: AppContext;
  project: ProjectRow;
}) {
  const stream = await getInitializedStreamStub({
    durableObjectNamespace: requireStreamDurableObjectNamespace(
      input.context,
    ) as unknown as StreamDurableObjectNamespace,
    namespace: input.project.id,
    path: PROJECT_LIFECYCLE_STREAM_PATH,
  });

  await stream.append({
    type: PROJECT_SETTINGS_UPDATED_EVENT_TYPE,
    payload: {
      customHostname: input.project.custom_hostname ?? null,
      externalEgressProxy: input.project.external_egress_proxy ?? null,
      metadata: JSON.parse(input.project.metadata) as Record<string, unknown>,
      projectId: input.project.id,
      slug: input.project.slug,
    },
  });
}

function requireStreamDurableObjectNamespace(context: AppContext) {
  if (!context.stream) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "STREAM binding not available.",
    });
  }

  return context.stream;
}
