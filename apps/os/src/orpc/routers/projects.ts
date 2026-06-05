import { ORPCError } from "@orpc/server";
import { StreamPath } from "@iterate-com/shared/streams/types";
import type { D1ObjectCatalogRecord } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import {
  getD1ObjectCatalogRecord,
  listD1ObjectCatalogRecordsByIndex,
} from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import type { AppContext } from "~/context.ts";
import {
  getProjectById,
  getProjectPermission,
  updateProjectConfig,
} from "~/db/queries/.generated/index.ts";
import type { CodemodeSessionStructuredName } from "~/domains/codemode/durable-objects/codemode-session.ts";
import {
  ensureProjectCustomHostname,
  ensureProjectCustomHostnameStatus,
} from "~/domains/projects/cloudflare-custom-hostnames.ts";
import { getProjectDurableObjectName } from "~/domains/projects/durable-objects/project-durable-object.ts";
import type { ProjectMcpServerConnectionStructuredName } from "~/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts";
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
import { ProjectsCapability } from "~/capnweb/projects-capability.ts";

type ProjectRow = {
  id: string;
  slug: string;
  custom_hostname?: string | null;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function toProjectWithIngressUrl(context: AppContext, row: ProjectRow) {
  return {
    ...toProject(row),
    ingressUrl: await projectDurableObject(context, row.id).ingressUrl(),
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

function isUniqueConstraintError(error: unknown) {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}

export const projectsRouter = {
  projects: {
    create: os.projects.create
      .use(activeOrganizationMiddleware)
      .handler(async ({ context, input }) => {
        return await new ProjectsCapability({
          activeOrganization: context.activeOrganization,
          context,
        }).create(input);
      }),
    list: os.projects.list.use(activeOrganizationMiddleware).handler(async ({ context, input }) => {
      return await new ProjectsCapability({
        activeOrganization: context.activeOrganization,
        context,
      }).list(input);
    }),
    find: os.projects.find.use(activeOrganizationMiddleware).handler(async ({ context, input }) => {
      return await new ProjectsCapability({
        activeOrganization: context.activeOrganization,
        context,
      }).find(input);
    }),
    findBySlug: os.projects.findBySlug
      .use(activeOrganizationMiddleware)
      .handler(async ({ context, input }) => {
        return await new ProjectsCapability({
          activeOrganization: context.activeOrganization,
          context,
        }).findBySlug(input);
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
        try {
          await updateProjectConfig(
            context.db,
            {
              customHostname: nextCustomHostname,
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

        if (row.custom_hostname) {
          await ensureProjectCustomHostnameStatus({
            apiToken: context.config.cloudflare.apiToken?.exposeSecret(),
            customHostname: row.custom_hostname,
            projectHostnameBase: context.projectHostnameBases[0],
          });
        }

        return await toProjectWithIngressUrl(context, row);
      }),
    customHostnameStatus: os.projects.customHostnameStatus
      .use(activeOrganizationMiddleware)
      .handler(async ({ context, input }) => {
        const row = await requireProject({
          activeOrganization: context.activeOrganization,
          context,
          projectId: input.id,
        });

        return await ensureProjectCustomHostnameStatus({
          apiToken: context.config.cloudflare.apiToken?.exposeSecret(),
          customHostname: row.custom_hostname,
          projectHostnameBase: context.projectHostnameBases[0],
        });
      }),
    ensureCustomHostname: os.projects.ensureCustomHostname
      .use(activeOrganizationMiddleware)
      .handler(async ({ context, input }) => {
        const row = await requireProject({
          activeOrganization: context.activeOrganization,
          context,
          projectId: input.id,
        });

        if (!row.custom_hostname) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Set a custom hostname before activating app hostnames.",
          });
        }

        const hostname = normalizeCustomHostname(input.hostname);
        if (!hostname || !isValidCustomHostname(hostname)) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Hostname must be a valid DNS hostname.",
          });
        }

        return await ensureProjectCustomHostname({
          apiToken: context.config.cloudflare.apiToken?.exposeSecret(),
          customHostname: row.custom_hostname,
          hostname,
          projectHostnameBase: context.projectHostnameBases[0],
        });
      }),
    remove: os.projects.remove
      .use(activeOrganizationMiddleware)
      .handler(async ({ context, input }) => {
        return await new ProjectsCapability({
          activeOrganization: context.activeOrganization,
          context,
        }).remove(input);
      }),
  },
  project: {
    get: os.project.get.use(projectScopeMiddleware).handler(async ({ context }) => {
      const row = requireProjectScope(context);
      return await toProjectWithIngressUrl(context, row);
    }),
    lifecycleState: os.project.lifecycleState
      .use(projectScopeMiddleware)
      .handler(async ({ context }) => {
        const project = requireProjectScope(context);
        return await projectLifecycleDurableObject(
          context,
          project.id,
        ).getProjectLifecycleRunnerState();
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

  if (input.context.principal?.can("read", { projectId: input.projectId })) {
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

function projectDurableObject(context: AppContext, projectId: string) {
  return requireProjectDurableObjectNamespace(context).getByName(
    getProjectDurableObjectName(projectId),
  );
}

type ProjectLifecycleStateRpc = {
  getProjectLifecycleRunnerState(): Promise<unknown>;
};

function projectLifecycleDurableObject(
  context: AppContext,
  projectId: string,
): ProjectLifecycleStateRpc {
  return requireProjectDurableObjectNamespace(context).getByName(
    getProjectDurableObjectName(projectId),
  ) as unknown as ProjectLifecycleStateRpc;
}
