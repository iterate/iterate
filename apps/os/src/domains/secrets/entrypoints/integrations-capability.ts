import { WorkerEntrypoint } from "cloudflare:workers";
import { createD1Client, type Client } from "sqlfu";
import { parseConfig, type AppConfig } from "~/config.ts";
import { replayPathCall } from "~/itx/path-proxy.ts";
import type { PathCall } from "~/itx/itx.ts";
import {
  createGoogleAuthorizationUrl,
  createSlackAuthorizationUrl,
  disconnectProvider,
  providerSecretKey,
  requestBaseUrl,
} from "~/domains/secrets/oauth.ts";
import { getProjectConnection, getProjectSecret } from "~/domains/secrets/secrets-store.ts";
import {
  appendNamespaceIntegrationEvent,
  GOOGLE_DISCONNECTED_EVENT_TYPE,
  SLACK_DISCONNECTED_EVENT_TYPE,
} from "~/domains/secrets/integration-streams.ts";

type IntegrationsCapabilityEnv = {
  APP_CONFIG?: string;
  DB?: D1Database;
};

type IntegrationsCapabilityProps = {
  projectId?: string;
};

type IntegrationProvider = "google" | "slack";

/**
 * The itx-reachable project integrations surface: connection status, OAuth
 * start, and disconnect for slack/google. Mirrors the oRPC integrations router
 * (orpc/routers/integrations.ts) one-for-one so the dashboard can call
 * `itx.integrations.getConnection/startOAuthFlow/disconnect` instead.
 *
 * Two deliberate differences from the oRPC version, both forced by itx's shape
 * (a loopback capability has props `{ projectId }` and NOTHING else — no
 * RequestContext, no request, no principal; itx calls arrive over a long-lived
 * socket, see ItxOrigin in itx/types.ts which carries only `{ ref, address }`):
 *
 *  1. The OAuth redirect base URL comes from `config.baseUrl` via
 *     `requestBaseUrl({ config })` — there is no inbound Request to read a host
 *     from. `config.baseUrl` must therefore be set in this deployment's config
 *     (it always is in non-localhost configs).
 *
 *  2. startOAuthFlow needs the userId that the callback re-verifies
 *     (integration-api.ts `requireCallbackUser`: the user who completes the
 *     OAuth callback must equal the user recorded in the OAuth state). The itx
 *     capability layer has NO principal — it is project-scoped only. So userId
 *     is taken as an argument here, with the firm contract that it is the
 *     connection-AUTHENTICATED user (the principal the itx WebSocket session
 *     authenticated), NOT a value the browser chose. The callback's
 *     requireCallbackUser check is the real security backstop regardless.
 *     Threading the connection principal into itx is a follow-up; until then
 *     the route handler that holds the verified principal supplies it.
 */
export class IntegrationsCapability extends WorkerEntrypoint<
  IntegrationsCapabilityEnv,
  IntegrationsCapabilityProps
> {
  /** The itx kernel's one calling convention; replay walks this entrypoint's own members. */
  call(input: PathCall): Promise<unknown> {
    return replayPathCall(this, input);
  }

  async getConnection(input: { provider: IntegrationProvider }) {
    const db = this.db();
    const projectId = this.projectId();
    const connection = await getProjectConnection(db, {
      projectId,
      provider: input.provider,
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

    const secret = await getProjectSecret(db, {
      key: providerSecretKey(input.provider),
      projectId,
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

  async startOAuthFlow(input: {
    provider: IntegrationProvider;
    callbackUrl?: string;
    /** The connection-authenticated user (see class docs) — never browser-supplied. */
    userId: string;
  }): Promise<{ authorizationUrl: string }> {
    const config = this.config();
    const db = this.db();
    const projectId = this.projectId();
    const baseUrl = requestBaseUrl({ config });
    const create =
      input.provider === "slack" ? createSlackAuthorizationUrl : createGoogleAuthorizationUrl;
    const authorizationUrl = await create({
      baseUrl,
      callbackUrl: input.callbackUrl,
      config,
      db,
      projectId,
      userId: input.userId,
    });
    return { authorizationUrl };
  }

  async disconnect(input: { provider: IntegrationProvider }) {
    const db = this.db();
    const projectId = this.projectId();
    const connection = await getProjectConnection(db, {
      projectId,
      provider: input.provider,
    });
    const result = await disconnectProvider({
      db,
      projectId,
      provider: input.provider,
    });
    if (connection) {
      const event =
        input.provider === "slack"
          ? {
              type: SLACK_DISCONNECTED_EVENT_TYPE,
              payload: {
                connectionId: connection.id,
                externalId: connection.externalId,
                projectId,
                scopes: parseScopes(connection.scopes, ","),
                teamDomain: readStringMetadata(connection.providerData, "teamDomain"),
                teamId:
                  readStringMetadata(connection.providerData, "teamId") ?? connection.externalId,
                teamName: readStringMetadata(connection.providerData, "teamName"),
                webhookProviderIdentifier: connection.webhookProviderIdentifier,
              },
            }
          : {
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
                projectId,
                scopes: parseScopes(connection.scopes, " "),
              },
            };
      await appendNamespaceIntegrationEvent({
        event,
        exports: this.ctx.exports as unknown as Pick<Cloudflare.Exports, "StreamsBackend">,
        projectId,
        provider: input.provider,
      });
    }
    return result;
  }

  private config(): AppConfig {
    return parseConfig(this.env);
  }

  private db(): Client {
    if (!this.env.DB) {
      throw new Error("IntegrationsCapability requires a DB binding.");
    }
    return createD1Client(this.env.DB);
  }

  private projectId(): string {
    const projectId = this.ctx.props.projectId;
    if (!projectId) throw new Error("IntegrationsCapability requires ctx.props.projectId.");
    return projectId;
  }
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
