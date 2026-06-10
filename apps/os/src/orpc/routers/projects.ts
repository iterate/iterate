import { env } from "cloudflare:workers";
import { ORPCError } from "@orpc/server";
import { StreamPath } from "@iterate-com/shared/streams/types";
import type { D1ObjectCatalogRecord } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { listD1ObjectCatalogRecordsByIndex } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import type { RequestContext } from "~/request-context.ts";
import { getProjectById, updateProjectConfig } from "~/db/queries/.generated/index.ts";
import {
  ensureProjectCustomHostname,
  ensureProjectCustomHostnameStatus,
} from "~/domains/projects/cloudflare-custom-hostnames.ts";
import { getProjectDurableObjectStub } from "~/domains/projects/durable-objects/project-durable-object.ts";
import type { ProjectMcpServerConnectionStructuredName } from "~/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts";
import {
  isReservedProjectHostname,
  isValidCustomHostname,
  normalizeCustomHostname,
} from "~/lib/project-host-routing.ts";
import { authenticatedUserMiddleware, os, projectScopeMiddleware } from "~/orpc/orpc.ts";
import { requireAuthorizedProject, requireProjectScope } from "~/orpc/project-access.ts";
import { projectAgentsRouter } from "~/orpc/routers/agents.ts";
import { projectReposRouter } from "~/orpc/routers/repos.ts";
import { projectIntegrationsRouter } from "~/orpc/routers/integrations.ts";
import { projectSecretsRouter } from "~/orpc/routers/secrets.ts";
import { projectStreamsRouter } from "~/orpc/routers/streams.ts";
import { ProjectsCapability } from "~/domains/projects/project-directory.ts";

type ProjectRow = {
  id: string;
  slug: string;
  custom_hostname?: string | null;
  created_at: string;
  updated_at: string;
};

type InboundMcpSessionCatalogRecord =
  D1ObjectCatalogRecord<ProjectMcpServerConnectionStructuredName>;

function toProject(row: ProjectRow) {
  return {
    id: row.id,
    slug: row.slug,
    customHostname: row.custom_hostname ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isOrphanedProjectFromAuthService: false,
  };
}

async function toProjectWithIngressUrl(row: ProjectRow) {
  return {
    ...toProject(row),
    ingressUrl: await projectDurableObject(row.id).ingressUrl(),
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
      .use(authenticatedUserMiddleware)
      .handler(async ({ context, input }) => {
        return await new ProjectsCapability({
          context,
        }).create(input);
      }),
    list: os.projects.list.use(authenticatedUserMiddleware).handler(async ({ context, input }) => {
      return await new ProjectsCapability({
        context,
      }).list(input);
    }),
    find: os.projects.find.use(authenticatedUserMiddleware).handler(async ({ context, input }) => {
      return await new ProjectsCapability({
        context,
      }).find(input);
    }),
    findBySlug: os.projects.findBySlug
      .use(authenticatedUserMiddleware)
      .handler(async ({ context, input }) => {
        return await new ProjectsCapability({
          context,
        }).findBySlug(input);
      }),
    updateConfig: os.projects.updateConfig
      .use(authenticatedUserMiddleware)
      .handler(async ({ context, input }) => {
        const existing = await requireProject({
          context,
          projectId: input.id,
        });

        const normalizedCustomHostname = normalizeConfigCustomHostname(
          input.customHostname,
          context.config.projectHostnameBases,
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
            projectHostnameBase: context.config.projectHostnameBases[0],
          });
        }

        return await toProjectWithIngressUrl(row);
      }),
    customHostnameStatus: os.projects.customHostnameStatus
      .use(authenticatedUserMiddleware)
      .handler(async ({ context, input }) => {
        const row = await requireProject({
          context,
          projectId: input.id,
        });

        return await ensureProjectCustomHostnameStatus({
          apiToken: context.config.cloudflare.apiToken?.exposeSecret(),
          customHostname: row.custom_hostname,
          projectHostnameBase: context.config.projectHostnameBases[0],
        });
      }),
    ensureCustomHostname: os.projects.ensureCustomHostname
      .use(authenticatedUserMiddleware)
      .handler(async ({ context, input }) => {
        const row = await requireProject({
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
          projectHostnameBase: context.config.projectHostnameBases[0],
        });
      }),
    remove: os.projects.remove
      .use(authenticatedUserMiddleware)
      .handler(async ({ context, input }) => {
        return await new ProjectsCapability({
          context,
        }).remove(input);
      }),
  },
  project: {
    get: os.project.get.use(projectScopeMiddleware).handler(async ({ context }) => {
      const row = requireProjectScope(context);
      return await toProjectWithIngressUrl(row);
    }),
    lifecycleState: os.project.lifecycleState
      .use(projectScopeMiddleware)
      .handler(async ({ context }) => {
        const project = requireProjectScope(context);
        // Raw Workers stub: await the property before calling (workerd does
        // not pipeline through property accesses; itx handles wrap this).
        const processor = await projectStateDurableObject(project.id).processor;
        return await processor.snapshot();
      }),
    agents: projectAgentsRouter,
    repos: projectReposRouter,
    inboundMcpServer: {
      listSessions: os.project.inboundMcpServer.listSessions
        .use(projectScopeMiddleware)
        .handler(async ({ context }) => {
          const project = requireProjectScope(context);
          const rows =
            await listD1ObjectCatalogRecordsByIndex<ProjectMcpServerConnectionStructuredName>(
              env.DB,
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

async function requireProject(input: { context: RequestContext; projectId: string }) {
  return await requireAuthorizedProject(input);
}

function projectDurableObject(projectId: string) {
  return getProjectDurableObjectStub(projectId);
}

// Processors extend RpcTarget (capnweb's, which IS cloudflare:workers' inside
// workerd), so the `processor` getter traverses the stub.
type ProjectStateRpc = {
  processor: { snapshot(): Promise<unknown> };
};

function projectStateDurableObject(projectId: string): ProjectStateRpc {
  return getProjectDurableObjectStub(projectId) as unknown as ProjectStateRpc;
}
