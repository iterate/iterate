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
import { ensureIntegrationStub } from "~/domains/integrations/durable-objects/integration-durable-object.ts";
import { ensureDiscordGatewayStub } from "~/domains/integrations/durable-objects/discord-gateway-durable-object.ts";
import { ensureSecretStub } from "~/domains/secrets/durable-objects/secret-durable-object.ts";
import { setJournaledSecret } from "~/domains/secrets/secret-streams.ts";
import { os, projectScopeMiddleware } from "~/orpc/orpc.ts";
import { requireProjectScope } from "~/orpc/project-access.ts";

export const projectIntegrationsRouter = {
  // ---- registry-driven integrations (spike) -------------------------------
  connect: os.project.integrations.connect
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      const definition = getIntegration(input.integration);
      const knownSecretNames = new Set(definition.providedSecrets.map((spec) => spec.name));
      for (const secret of input.secrets) {
        if (!knownSecretNames.has(secret.name)) {
          throw new ORPCError("BAD_REQUEST", {
            message: `${definition.slug} does not provide a Secret named ${secret.name}.`,
          });
        }
      }
      return await connectIntegration({
        integration: definition.slug,
        account: input.account,
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
      const stub = await ensureIntegrationStub({
        account: input.account,
        integration: definition.slug,
        projectId: project.id,
      });
      return await stub.ensureReady();
    }),
  setJournaledSecret: os.project.integrations.setJournaledSecret
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      const event = await setJournaledSecret({
        projectId: project.id,
        slug: input.slug,
        ...(input.material == null ? {} : { material: input.material }),
        ...(input.metadata == null ? {} : { metadata: input.metadata }),
        ...(input.tier == null ? {} : { tier: input.tier }),
        ...(input.sensitivity == null ? {} : { sensitivity: input.sensitivity }),
        ...(input.expiresAt == null ? {} : { expiresAt: input.expiresAt }),
        ...(input.derivation == null
          ? {}
          : {
              derivation: input.derivation as Parameters<
                typeof setJournaledSecret
              >[0]["derivation"],
            }),
        source: { kind: "orpc" },
      });
      return { slug: input.slug, offset: event.offset };
    }),
  describeJournaledSecret: os.project.integrations.describeJournaledSecret
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      const stub = await ensureSecretStub({ projectId: project.id, slug: input.slug });
      return await stub.describe();
    }),
  ensureDiscordGateway: os.project.integrations.ensureDiscordGateway
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      const scope =
        input.ownership === "customer" ? `project:${project.id}:${input.account}` : "first-party";
      const stub = await ensureDiscordGatewayStub(scope);
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
