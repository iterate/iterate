// Project integrations, post-clean-cut: everything runs on the registry +
// journaled Secrets. Slack and Google connections are integration ACCOUNTS
// (folds over /integrations/{slug}/{account}); OAuth state is a signed
// stateless token; tokens live as journaled Secrets. The legacy D1 tables
// (project_connections / project_secrets / oauth_states) are gone.

import { env } from "cloudflare:workers";
import { ORPCError } from "@orpc/server";
import { listD1ObjectCatalogRecordsByIndex } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { getProjectById } from "~/db/queries/.generated/index.ts";
import type { PendingConnect } from "~/domains/integrations/definition.ts";
import { unsealJson } from "~/domains/secrets/oauth-state.ts";
import type { RequestContext } from "~/request-context.ts";
import { connectIntegration, RoutingKeyConflictError } from "~/domains/integrations/connect.ts";
import { getIntegration } from "~/domains/integrations/registry.ts";
import { providedSecretSlug } from "~/domains/integrations/definition.ts";
import {
  DEFAULT_INTEGRATION_ACCOUNT,
  integrationAccountStreamPath,
  integrationIngressStreamPath,
} from "~/domains/integrations/integration-events.ts";
import {
  ensureIntegrationStub,
  listConnectedIntegrationAccountStates,
  type IntegrationAccountState,
} from "~/domains/integrations/durable-objects/integration-durable-object.ts";
import { ensureDiscordGatewayStub } from "~/domains/integrations/durable-objects/discord-gateway-durable-object.ts";
import {
  buildSlackAuthorizationUrl,
  SLACK_ACCESS_TOKEN_SECRET_NAME,
} from "~/domains/integrations/providers/slack.ts";
import {
  buildGoogleAuthorizationUrl,
  GOOGLE_ACCESS_TOKEN_SECRET_NAME,
  GOOGLE_REFRESH_TOKEN_SECRET_NAME,
} from "~/domains/integrations/providers/google.ts";
import {
  ensureSecretStub,
  type SecretDescription,
} from "~/domains/secrets/durable-objects/secret-durable-object.ts";
import { setJournaledSecret } from "~/domains/secrets/secret-streams.ts";
import { secretStreamPath } from "~/domains/secrets/stream-processors/secret/contract.ts";
import { signOAuthState } from "~/domains/secrets/oauth-state.ts";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "~/domains/streams/stream-runtime.ts";
import { os, projectScopeMiddleware } from "~/orpc/orpc.ts";
import { requireProjectScope } from "~/orpc/project-access.ts";

type IntegrationsEnv = {
  GLOBAL_STREAM_NAMESPACE: string;
  SECRETS_ENCRYPTION_KEY?: string;
  STREAM: StreamDurableObjectNamespace;
};

export const projectIntegrationsRouter = {
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
      try {
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
      } catch (error) {
        if (error instanceof RoutingKeyConflictError) {
          throw new ORPCError("CONFLICT", { message: error.message });
        }
        throw error;
      }
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
  describePendingConnect: os.project.integrations.describePendingConnect
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      const pending = await unsealPendingConnect(input.token, project.id);
      const ownerProject = await getProjectById(context.db, {
        id: pending.conflict.owner.projectId,
      });
      return {
        integration: pending.integration,
        account: pending.connect.account ?? DEFAULT_INTEGRATION_ACCOUNT,
        externalId: pending.connect.externalId,
        displayName: pending.connect.displayName ?? null,
        routingKey: pending.conflict.routingKey,
        currentOwner: {
          projectId: pending.conflict.owner.projectId,
          projectSlug: ownerProject?.slug ?? null,
          account: pending.conflict.owner.account,
        },
        targetProjectId: pending.connect.projectId,
      };
    }),
  confirmPendingConnect: os.project.integrations.confirmPendingConnect
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      const pending = await unsealPendingConnect(input.token, project.id);
      const result = await connectIntegration({
        ...pending.connect,
        integration: pending.integration,
        takeover: true,
      });
      return result;
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

  // ---- slack / google (UI surface) — same contract, new system ------------
  getSlackConnection: os.project.integrations.getSlackConnection
    .use(projectScopeMiddleware)
    .handler(async ({ context }) => {
      return await connectionStatus(context, {
        integration: "slack",
        tokenSecretName: SLACK_ACCESS_TOKEN_SECRET_NAME,
        scopeSeparator: ",",
      });
    }),
  startSlackOAuthFlow: os.project.integrations.startSlackOAuthFlow
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      const slack = context.config.integrations.slack;
      if (!slack) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Slack not configured." });
      }
      const baseUrl = requestBaseUrl(context);
      return {
        authorizationUrl: buildSlackAuthorizationUrl({
          clientId: slack.oauthClientId,
          scopes: slack.scopes,
          redirectUri: `${baseUrl}/api/integrations/slack/callback`,
          state: await signState({
            provider: "slack",
            projectId: project.id,
            userId: requireUserId(context),
            ...(input.callbackUrl == null ? {} : { callbackUrl: input.callbackUrl }),
          }),
        }),
      };
    }),
  disconnectSlack: os.project.integrations.disconnectSlack
    .use(projectScopeMiddleware)
    .handler(async ({ context }) => {
      const project = requireProjectScope(context);
      return await disconnectAccount(project.id, "slack");
    }),
  getGoogleConnection: os.project.integrations.getGoogleConnection
    .use(projectScopeMiddleware)
    .handler(async ({ context }) => {
      return await connectionStatus(context, {
        integration: "google",
        tokenSecretName: GOOGLE_ACCESS_TOKEN_SECRET_NAME,
        refreshSecretName: GOOGLE_REFRESH_TOKEN_SECRET_NAME,
        scopeSeparator: " ",
      });
    }),
  startGoogleOAuthFlow: os.project.integrations.startGoogleOAuthFlow
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      const google = context.config.integrations.google;
      if (!google) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Google not configured." });
      }
      const baseUrl = requestBaseUrl(context);
      const codeVerifier = randomBase64Url(32);
      return {
        authorizationUrl: buildGoogleAuthorizationUrl({
          clientId: google.oauthClientId,
          scopes: google.scopes,
          redirectUri: `${baseUrl}/api/integrations/google/callback`,
          codeChallenge: await sha256Base64Url(codeVerifier),
          state: await signState({
            provider: "google",
            projectId: project.id,
            userId: requireUserId(context),
            codeVerifier,
            ...(input.callbackUrl == null ? {} : { callbackUrl: input.callbackUrl }),
          }),
        }),
      };
    }),
  disconnectGoogle: os.project.integrations.disconnectGoogle
    .use(projectScopeMiddleware)
    .handler(async ({ context }) => {
      const project = requireProjectScope(context);
      return await disconnectAccount(project.id, "google");
    }),
};

async function connectionStatus(
  context: RequestContext,
  input: {
    integration: string;
    tokenSecretName: string;
    refreshSecretName?: string;
    /** Provider scope-list convention (slack joins with ",", google with " "). */
    scopeSeparator: "," | " ";
  },
) {
  const project = requireProjectScope(context);
  // Accounts are per-workspace now (any number of Slacks): discover every
  // connected one (deterministically ordered) and surface them all. The
  // top-level single-connection fields describe the FIRST account, for the
  // existing card UI; `accounts` carries the full list.
  const states = await allConnectedAccountStates(project.id, input.integration);
  const state = states[0];
  const accounts = states.map((each) => ({
    account: each.account ?? DEFAULT_INTEGRATION_ACCOUNT,
    displayName: each.connection.displayName ?? null,
    externalId: each.connection.externalId ?? null,
  }));
  if (state == null) {
    return {
      accounts,
      connected: false,
      displayName: null,
      externalId: null,
      metadata: {},
      scopes: null,
      token: null,
    };
  }

  const account = state.account ?? DEFAULT_INTEGRATION_ACCOUNT;
  const token = await describeSecretOrNull(project.id, {
    integration: input.integration,
    account,
    name: input.tokenSecretName,
  });
  const refresh = input.refreshSecretName
    ? await describeSecretOrNull(project.id, {
        integration: input.integration,
        account,
        name: input.refreshSecretName,
      })
    : null;
  const scopes = token?.metadata?.scopes;
  return {
    accounts,
    connected: true,
    displayName: state.connection.displayName ?? null,
    externalId: state.connection.externalId ?? null,
    metadata: (token?.metadata ?? {}) as Record<string, unknown>,
    scopes: Array.isArray(scopes) ? scopes.join(input.scopeSeparator) : null,
    token:
      token == null
        ? null
        : {
            expiresAt: token.expiresAt ?? null,
            hasMaterial: token.hasMaterial === true || token.derivation != null,
            refreshTokenStored: refresh?.hasMaterial === true,
          },
  };
}

type AccountState = IntegrationAccountState;

async function allConnectedAccountStates(
  projectId: string,
  integration: string,
): Promise<AccountState[]> {
  return await listConnectedIntegrationAccountStates({ projectId, integration });
}

async function describeSecretOrNull(
  projectId: string,
  ref: { integration: string; account: string; name: string },
) {
  try {
    const stub = await ensureSecretStub({
      projectId,
      slug: providedSecretSlug({
        integration: ref.integration,
        account: ref.account,
        name: ref.name,
      }),
    });
    const described = (await stub.describe()) as SecretDescription;
    return described.status === "set" ? described : null;
  } catch {
    return null;
  }
}

/** Disconnect = the mirror choreography for EVERY connected account of the
 * integration: the disconnected fact on each account stream, route claims
 * released on the global stream, secrets deleted. */
async function disconnectAccount(projectId: string, integration: string) {
  const states = await allConnectedAccountStates(projectId, integration);
  for (const state of states) {
    await disconnectOneAccount(projectId, integration, state);
  }
  return { success: true };
}

async function disconnectOneAccount(projectId: string, integration: string, state: AccountState) {
  const integrationsEnv = env as unknown as IntegrationsEnv;
  const account = state.account ?? DEFAULT_INTEGRATION_ACCOUNT;

  const accountStream = await getInitializedStreamStub({
    durableObjectNamespace: integrationsEnv.STREAM,
    namespace: projectId,
    path: integrationAccountStreamPath(integration, account),
  });
  await accountStream.append({
    type: "events.iterate.com/integration/disconnected",
    idempotencyKey: `integration-disconnected:${integration}:${account}:${crypto.randomUUID()}`,
    payload: {
      integration,
      account,
      projectId,
      ...(state.connection.externalId == null ? {} : { externalId: state.connection.externalId }),
    },
  });

  const ingressStream = await getInitializedStreamStub({
    durableObjectNamespace: integrationsEnv.STREAM,
    namespace: integrationsEnv.GLOBAL_STREAM_NAMESPACE,
    path: integrationIngressStreamPath(integration),
  });
  for (const routingKey of state.connection.routingKeys) {
    await ingressStream.append({
      type: "events.iterate.com/integration/route-removed",
      idempotencyKey: `integration-route-removed:${integration}:${routingKey}:${crypto.randomUUID()}`,
      payload: { integration, routingKey },
    });
  }

  for (const slug of state.connection.providedSecretSlugs) {
    const secretStream = await getInitializedStreamStub({
      durableObjectNamespace: integrationsEnv.STREAM,
      namespace: projectId,
      path: secretStreamPath(slug),
    });
    await secretStream.append({
      type: "events.iterate.com/secret/deleted",
      idempotencyKey: `secret-deleted:${slug}:${crypto.randomUUID()}`,
      payload: { slug },
    });
  }
}

function requestBaseUrl(context: RequestContext) {
  const base =
    context.config.baseUrl ??
    (context.rawRequest ? new URL(context.rawRequest.url).origin : undefined);
  if (!base) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Cannot infer base URL." });
  return base.replace(/\/$/, "");
}

async function signState(payload: {
  provider: string;
  projectId: string;
  userId: string;
  callbackUrl?: string;
  codeVerifier?: string;
}) {
  const key = (env as unknown as IntegrationsEnv).SECRETS_ENCRYPTION_KEY;
  if (!key) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "SECRETS_ENCRYPTION_KEY is required for OAuth flows.",
    });
  }
  return await signOAuthState({ key, payload, nowMs: Date.now() });
}

/** Unseal + authorize a pending connect: it must belong to the scoped
 * project (the sealed payload is tamper-proof; this binds it to the caller). */
async function unsealPendingConnect(token: string, projectId: string): Promise<PendingConnect> {
  const key = (env as unknown as IntegrationsEnv).SECRETS_ENCRYPTION_KEY;
  if (!key) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "SECRETS_ENCRYPTION_KEY is required for pending connects.",
    });
  }
  const unsealed = await unsealJson({ key, token, nowMs: Date.now() });
  if (unsealed == null) {
    throw new ORPCError("BAD_REQUEST", { message: "Pending connect is invalid or expired." });
  }
  const pending = unsealed as unknown as PendingConnect;
  if (pending.connect?.projectId !== projectId) {
    throw new ORPCError("FORBIDDEN", {
      message: "Pending connect belongs to a different project.",
    });
  }
  return pending;
}

function requireUserId(context: RequestContext) {
  if (context.principal?.type !== "user") throw new ORPCError("UNAUTHORIZED");
  return context.principal.userId;
}

function randomBase64Url(byteLength: number) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256Base64Url(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
