import { createFileRoute } from "@tanstack/react-router";
import { handleMcpStartRoute } from "./api.mcp.ts";
import { MCP_START_MOUNT_PATH } from "~/lib/mcp-base-url.ts";
import { handleIntegrationApiRequest } from "~/domains/integrations/integration-api.ts";
import { handleProjectAuthStart } from "~/auth/project-auth.ts";
import { itxEnv } from "~/env.ts";
import { decideIngressRoute } from "~/ingress.ts";
import { readProjectByHostname } from "~/project-hostname-directory.ts";
import { resolveProjectIdBySlug } from "~/project-directory.ts";

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      ANY: async ({ context, request }) => {
        const requestContext = { ...context, rawRequest: request };
        const pathname = new URL(request.url).pathname;
        if (pathname === "/api/project-auth/start") {
          return await handleProjectAuthStart({
            request,
            session: context.iterateAuthSession
              ? {
                  userId: context.iterateAuthSession.user.id,
                  email: context.iterateAuthSession.user.email || undefined,
                  image: context.iterateAuthSession.user.picture || undefined,
                  name: context.iterateAuthSession.user.name || undefined,
                }
              : null,
            mintSession: (input) => itxEnv.AUTH.mintProjectAppSession(input),
            resolveProjectId: async (targetUrl) => {
              const route = await decideIngressRoute({
                config: context.config,
                method: "GET",
                url: targetUrl,
                resolvers: {
                  projectIdBySlug: (identifier) =>
                    resolveProjectIdBySlug({
                      directory: itxEnv.PROJECT_DIRECTORY,
                      identifier,
                    }),
                  projectByHostname: async (host) => {
                    const found = await readProjectByHostname(itxEnv.PROJECT_DIRECTORY, host);
                    return found ? { appSlug: found.appSlug, projectId: found.record.id } : null;
                  },
                },
              });
              return route.lane === "project" ? route.resolved.projectId : null;
            },
          });
        }
        if (pathname === MCP_START_MOUNT_PATH || pathname.startsWith(`${MCP_START_MOUNT_PATH}/`)) {
          return await handleMcpStartRoute({ context: requestContext, request });
        }

        const integrationResponse = await handleIntegrationApiRequest({
          auth: context.principal,
          context: requestContext,
          request,
        });
        if (integrationResponse !== null) return integrationResponse;

        return Response.json({ error: "not_found" }, { status: 404 });
      },
    },
  },
});
