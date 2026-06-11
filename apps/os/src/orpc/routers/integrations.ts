import { ORPCError } from "@orpc/server";
import type { RequestContext } from "~/request-context.ts";
import {
  createGoogleAuthorizationUrl,
  createSlackAuthorizationUrl,
  disconnectProvider,
  providerSecretKey,
  requestBaseUrl,
} from "~/domains/secrets/oauth.ts";
import {
  appendIntegrationEvent,
  GOOGLE_DISCONNECTED_EVENT_TYPE,
  SLACK_DISCONNECTED_EVENT_TYPE,
} from "~/domains/secrets/integration-streams.ts";
import { getProjectConnection, getProjectSecret } from "~/domains/secrets/secrets-store.ts";
import { connectIntegration } from "~/domains/integrations/connect.ts";
import { getIntegration } from "~/domains/integrations/registry.ts";
import {
  getIntegrationDurableObjectName,
  getIntegrationStub,
} from "~/domains/integrations/durable-objects/integration-durable-object.ts";
import {
  getDiscordGatewayDurableObjectName,
  getDiscordGatewayStub,
} from "~/domains/integrations/durable-objects/discord-gateway-durable-object.ts";
import {
  getSecretDurableObjectName,
  getSecretStub,
} from "~/domains/secrets/durable-objects/secret-durable-object.ts";
import { os, projectScopeMiddleware } from "~/orpc/orpc.ts";
import { requireProjectScope } from "~/orpc/project-access.ts";

export const projectIntegrationsRouter = {
  // ---- registry-driven integrations (spike) -------------------------------
  connect: os.project.integrations.connect
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      const definition = getIntegration(input.integration);
      const knownSecretSlugs = new Set(definition.providedSecrets.map((spec) => spec.slug));
      for (const secret of input.secrets) {
        if (!knownSecretSlugs.has(secret.slug)) {
          throw new ORPCError("BAD_REQUEST", {
            message: `${definition.slug} does not provide a Secret named ${secret.slug}.`,
          });
        }
      }
      return await connectIntegration({
        integration: definition.slug,
        projectId: project.id,
        ownership: input.ownership,
        externalId: input.externalId,
        ...(input.displayName == null ? {} : { displayName: input.displayName }),
        routingKeys: input.routingKeys,
        secrets: input.secrets,
      });
    }),
  getIntegrationState: os.project.integrations.getIntegrationState
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      const definition = getIntegration(input.integration);
      const stub = getIntegrationStub({ integration: definition.slug, projectId: project.id });
      await stub.initialize({
        name: getIntegrationDurableObjectName({
          integration: definition.slug,
          projectId: project.id,
        }),
      });
      return await stub.ensureReady();
    }),
  describeJournaledSecret: os.project.integrations.describeJournaledSecret
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      const stub = getSecretStub({ projectId: project.id, slug: input.slug });
      await stub.initialize({
        name: getSecretDurableObjectName({ projectId: project.id, slug: input.slug }),
      });
      return await stub.describe();
    }),
  ensureDiscordGateway: os.project.integrations.ensureDiscordGateway
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      const scope = input.ownership === "customer" ? `project:${project.id}` : "first-party";
      const stub = getDiscordGatewayStub(scope);
      await stub.initialize({ name: getDiscordGatewayDurableObjectName({ scope }) });
      return await stub.ensureConnected();
    }),
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

async function connectionStatus(context: RequestContext, provider: "google" | "slack") {
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
      token: null,
    };
  }

  const secret = await getProjectSecret(context.db, {
    key: providerSecretKey(provider),
    projectId: project.id,
  });

  return {
    connected: true,
    displayName: readDisplayName(connection.providerData),
    externalId: connection.externalId,
    metadata: connection.providerData,
    scopes: connection.scopes,
    token: secret
      ? {
          createdAt: secret.createdAt,
          expiresAt: readStringMetadata(secret.metadata, "expiresAt"),
          hasMaterial: secret.material.length > 0,
          refreshTokenStored: readStringMetadata(secret.metadata, "refreshToken") !== null,
          updatedAt: secret.updatedAt,
        }
      : null,
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

function requireUserId(context: RequestContext) {
  if (context.principal?.type !== "user") throw new ORPCError("UNAUTHORIZED");
  return context.principal.userId;
}
