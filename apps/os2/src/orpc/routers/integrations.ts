import { ORPCError } from "@orpc/server";
import type { AppContext } from "~/context.ts";
import {
  createGoogleAuthorizationUrl,
  createSlackAuthorizationUrl,
  disconnectProvider,
  requestBaseUrl,
} from "~/domains/secrets/oauth.ts";
import {
  appendIntegrationEvent,
  GOOGLE_DISCONNECTED_EVENT_TYPE,
  SLACK_DISCONNECTED_EVENT_TYPE,
} from "~/domains/secrets/integration-streams.ts";
import { getProjectConnection } from "~/domains/secrets/secrets-store.ts";
import { os, projectScopeMiddleware } from "~/orpc/orpc.ts";
import { requireProjectScope } from "~/orpc/project-access.ts";

export const projectIntegrationsRouter = {
  getSlackConnection: os.project.integrations.getSlackConnection
    .use(projectScopeMiddleware)
    .handler(async ({ context }) => connectionStatus(context, "slack")),
  startSlackOAuthFlow: os.project.integrations.startSlackOAuthFlow
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      return {
        authorizationUrl: await createSlackAuthorizationUrl({
          baseUrl: requestBaseUrl({ config: context.config, request: context.rawRequest }),
          callbackUrl: input.callbackUrl,
          config: context.config,
          db: context.db,
          projectId: project.id,
          userId: requireUserId(context),
        }),
      };
    }),
  disconnectSlack: os.project.integrations.disconnectSlack
    .use(projectScopeMiddleware)
    .handler(async ({ context }) => {
      const project = requireProjectScope(context);
      const connection = await getProjectConnection(context.db, {
        projectId: project.id,
        provider: "slack",
      });
      const result = await disconnectProvider({
        db: context.db,
        projectId: project.id,
        provider: "slack",
      });
      if (connection) {
        await appendIntegrationEvent(context, {
          projectId: project.id,
          provider: "slack",
          event: {
            type: SLACK_DISCONNECTED_EVENT_TYPE,
            payload: {
              connectionId: connection.id,
              externalId: connection.externalId,
              projectId: project.id,
              scopes: parseScopes(connection.scopes, ","),
              teamDomain: readStringMetadata(connection.providerData, "teamDomain"),
              teamId:
                readStringMetadata(connection.providerData, "teamId") ?? connection.externalId,
              teamName: readStringMetadata(connection.providerData, "teamName"),
              webhookProviderIdentifier: connection.webhookProviderIdentifier,
            },
          },
        });
      }
      return result;
    }),
  getGoogleConnection: os.project.integrations.getGoogleConnection
    .use(projectScopeMiddleware)
    .handler(async ({ context }) => connectionStatus(context, "google")),
  startGoogleOAuthFlow: os.project.integrations.startGoogleOAuthFlow
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      return {
        authorizationUrl: await createGoogleAuthorizationUrl({
          baseUrl: requestBaseUrl({ config: context.config, request: context.rawRequest }),
          callbackUrl: input.callbackUrl,
          config: context.config,
          db: context.db,
          projectId: project.id,
          userId: requireUserId(context),
        }),
      };
    }),
  disconnectGoogle: os.project.integrations.disconnectGoogle
    .use(projectScopeMiddleware)
    .handler(async ({ context }) => {
      const project = requireProjectScope(context);
      const connection = await getProjectConnection(context.db, {
        projectId: project.id,
        provider: "google",
      });
      const result = await disconnectProvider({
        db: context.db,
        projectId: project.id,
        provider: "google",
      });
      if (connection) {
        await appendIntegrationEvent(context, {
          projectId: project.id,
          provider: "google",
          event: {
            type: GOOGLE_DISCONNECTED_EVENT_TYPE,
            payload: {
              connectionId: connection.id,
              email: readStringMetadata(connection.providerData, "email"),
              externalId: connection.externalId,
              googleUserId:
                readStringMetadata(connection.providerData, "googleUserId") ??
                connection.externalId,
              name: readStringMetadata(connection.providerData, "name"),
              picture: readStringMetadata(connection.providerData, "picture"),
              projectId: project.id,
              scopes: parseScopes(connection.scopes, " "),
            },
          },
        });
      }
      return result;
    }),
};

async function connectionStatus(context: AppContext, provider: "google" | "slack") {
  const project = requireProjectScope(context);
  const connection = await getProjectConnection(context.db, {
    projectId: project.id,
    provider,
  });

  if (!connection) {
    return {
      connected: false,
      displayName: null,
      externalId: null,
      metadata: {},
      scopes: null,
    };
  }

  return {
    connected: true,
    displayName: readDisplayName(connection.providerData),
    externalId: connection.externalId,
    metadata: connection.providerData,
    scopes: connection.scopes,
  };
}

function readDisplayName(metadata: Record<string, unknown>) {
  const name = metadata.teamName ?? metadata.email ?? metadata.name;
  return typeof name === "string" ? name : null;
}

function readStringMetadata(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" ? value : null;
}

function parseScopes(scopes: string | null, separator: "," | " ") {
  if (!scopes) return [];
  return scopes
    .split(separator)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

function requireUserId(context: AppContext) {
  const userId = context.auth?.userId;
  if (!userId) throw new ORPCError("UNAUTHORIZED");
  return userId;
}
