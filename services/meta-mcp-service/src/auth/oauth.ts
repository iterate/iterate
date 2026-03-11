import { randomUUID } from "node:crypto";
import {
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  UnauthorizedError,
  auth,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { MetaMcpError } from "../errors.ts";
import {
  type AuthStore,
  type OAuthAuthorizationState,
  type OAuthStoreRecord,
  type ServerConfig,
} from "../config/schema.ts";
import { MetaMcpFileStore } from "../config/file-store.ts";

const OAUTH_AUTHORIZATION_TTL_MS = 15 * 60 * 1000;

function getOAuthRecord(authStore: AuthStore, serverId: string): OAuthStoreRecord {
  return authStore.oauth[serverId] ?? {};
}

function isOAuthAuthorizationActive(authorization?: OAuthAuthorizationState): boolean {
  if (!authorization) {
    return false;
  }

  return new Date(authorization.expiresAt).getTime() > Date.now();
}

function toOAuthTokens(record: OAuthStoreRecord): OAuthTokens | undefined {
  if (!record.accessToken || !record.tokenType) {
    return undefined;
  }

  return {
    access_token: record.accessToken,
    refresh_token: record.refreshToken,
    expires_in: record.expiresAt
      ? Math.max(0, Math.floor((new Date(record.expiresAt).getTime() - Date.now()) / 1000))
      : undefined,
    scope: record.scopes?.join(" "),
    token_type: record.tokenType,
  };
}

function fromOAuthTokens(
  tokens: OAuthTokens,
): Pick<OAuthStoreRecord, "accessToken" | "refreshToken" | "expiresAt" | "scopes" | "tokenType"> {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt:
      typeof tokens.expires_in === "number"
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : undefined,
    scopes: tokens.scope?.split(/\s+/).filter(Boolean),
    tokenType: tokens.token_type,
  };
}

export function supportsOAuth(server: ServerConfig): boolean {
  return server.auth.type === "oauth" || server.auth.type === "auto";
}

function getOAuthAuthConfig(
  server: ServerConfig,
): Extract<ServerConfig["auth"], { type: "oauth" | "auto" }> {
  if (!supportsOAuth(server)) {
    throw new Error(`Expected oauth auth type for server '${server.id}'`);
  }

  return server.auth as Extract<ServerConfig["auth"], { type: "oauth" | "auto" }>;
}

function defaultClientMetadata(params: {
  server: ServerConfig;
  redirectUrl: string;
}): OAuthClientMetadata {
  const authConfig = getOAuthAuthConfig(params.server);

  return {
    redirect_uris: [params.redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    client_name: authConfig.clientName ?? `Iterate Meta MCP (${params.server.id})`,
    client_uri: authConfig.clientUri,
    scope: authConfig.scope,
  };
}

async function updateOAuthRecord(params: {
  fileStore: MetaMcpFileStore;
  serverId: string;
  update: (current: OAuthStoreRecord) => OAuthStoreRecord;
}) {
  const authStore = await params.fileStore.loadAuthStore();
  const current = getOAuthRecord(authStore, params.serverId);
  const next = params.update(current);

  await params.fileStore.saveAuthStore({
    ...authStore,
    oauth: {
      ...authStore.oauth,
      [params.serverId]: next,
    },
  });
}

function buildOAuthCallbackUrl(params: { publicBaseUrl: string; server: ServerConfig }): string {
  const url = new URL("/oauth/callback", params.publicBaseUrl);
  url.searchParams.set("serverId", params.server.id);
  return url.toString();
}

function buildOAuthRedirectUrl(params: { publicBaseUrl: string; server: ServerConfig }): string {
  const authConfig = supportsOAuth(params.server) ? getOAuthAuthConfig(params.server) : undefined;
  return buildOAuthCallbackUrl({
    publicBaseUrl: authConfig?.redirectBaseUrl ?? params.publicBaseUrl,
    server: params.server,
  });
}

function buildLocalOAuthStartUrl(params: { publicBaseUrl: string; authState: string }): string {
  return new URL(`/mcp-auth/${params.authState}`, params.publicBaseUrl).toString();
}

function createOAuthAuthorizationState(params: {
  providerAuthUrl: string;
  publicBaseUrl: string;
  redirectUrl: string;
}): OAuthAuthorizationState {
  const localAuthState = randomUUID();
  return {
    authUrl: buildLocalOAuthStartUrl({
      publicBaseUrl: params.publicBaseUrl,
      authState: localAuthState,
    }),
    providerAuthUrl: params.providerAuthUrl,
    callbackUrl: params.redirectUrl,
    redirectUrl: params.redirectUrl,
    localAuthState,
    expiresAt: new Date(Date.now() + OAUTH_AUTHORIZATION_TTL_MS).toISOString(),
  };
}

function stripOAuthAuthorizationState(record: OAuthStoreRecord): OAuthStoreRecord {
  return {
    ...record,
    authorization: undefined,
    clientInformation: undefined,
    codeVerifier: undefined,
    discoveryState: undefined,
  };
}

class FileBackedOAuthClientProvider implements OAuthClientProvider {
  constructor(
    private readonly params: {
      server: ServerConfig;
      fileStore: MetaMcpFileStore;
      redirectUrl: string;
      onRedirect?: (authorizationUrl: URL) => void;
    },
  ) {}

  get redirectUrl(): string {
    return this.params.redirectUrl;
  }

  get clientMetadataUrl(): string | undefined {
    return supportsOAuth(this.params.server)
      ? getOAuthAuthConfig(this.params.server).clientMetadataUrl
      : undefined;
  }

  get clientMetadata(): OAuthClientMetadata {
    return defaultClientMetadata({
      server: this.params.server,
      redirectUrl: this.redirectUrl,
    });
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const authStore = await this.params.fileStore.loadAuthStore();
    return getOAuthRecord(authStore, this.params.server.id).clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await updateOAuthRecord({
      fileStore: this.params.fileStore,
      serverId: this.params.server.id,
      update: (current) => ({
        ...current,
        clientInformation,
      }),
    });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const authStore = await this.params.fileStore.loadAuthStore();
    return toOAuthTokens(getOAuthRecord(authStore, this.params.server.id));
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await updateOAuthRecord({
      fileStore: this.params.fileStore,
      serverId: this.params.server.id,
      update: (current) => ({
        ...current,
        ...fromOAuthTokens(tokens),
      }),
    });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.params.onRedirect?.(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await updateOAuthRecord({
      fileStore: this.params.fileStore,
      serverId: this.params.server.id,
      update: (current) => ({
        ...current,
        codeVerifier,
      }),
    });
  }

  async codeVerifier(): Promise<string> {
    const authStore = await this.params.fileStore.loadAuthStore();
    const codeVerifier = getOAuthRecord(authStore, this.params.server.id).codeVerifier;
    if (!codeVerifier) {
      throw new MetaMcpError("OAUTH_MISSING_CODE_VERIFIER", "Missing OAuth code verifier", {
        serverId: this.params.server.id,
      });
    }

    return codeVerifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await updateOAuthRecord({
      fileStore: this.params.fileStore,
      serverId: this.params.server.id,
      update: (current) => ({
        ...current,
        discoveryState: state,
      }),
    });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const authStore = await this.params.fileStore.loadAuthStore();
    const discoveryState = getOAuthRecord(authStore, this.params.server.id).discoveryState;
    return discoveryState as OAuthDiscoveryState | undefined;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    await updateOAuthRecord({
      fileStore: this.params.fileStore,
      serverId: this.params.server.id,
      update: (current) => {
        if (scope === "all") {
          return {};
        }

        return {
          ...current,
          ...(scope === "client" ? { clientInformation: undefined } : {}),
          ...(scope === "tokens"
            ? {
                accessToken: undefined,
                expiresAt: undefined,
                refreshToken: undefined,
                scopes: undefined,
                tokenType: undefined,
              }
            : {}),
          ...(scope === "verifier" ? { codeVerifier: undefined } : {}),
          ...(scope === "discovery" ? { discoveryState: undefined } : {}),
        };
      },
    });
  }
}

export function createOAuthClientProvider(params: {
  server: ServerConfig;
  fileStore: MetaMcpFileStore;
  publicBaseUrl: string;
  redirectUrlOverride?: string;
  onRedirect?: (authorizationUrl: URL) => void;
}) {
  return new FileBackedOAuthClientProvider({
    server: params.server,
    fileStore: params.fileStore,
    redirectUrl:
      params.redirectUrlOverride ??
      buildOAuthRedirectUrl({
        publicBaseUrl: params.publicBaseUrl,
        server: params.server,
      }),
    onRedirect: params.onRedirect,
  });
}

export async function getSavedOAuthAuthorization(params: {
  fileStore: MetaMcpFileStore;
  serverId: string;
}): Promise<OAuthAuthorizationState | undefined> {
  const authStore = await params.fileStore.loadAuthStore();
  const authorization = getOAuthRecord(authStore, params.serverId).authorization;

  if (!authorization) {
    return undefined;
  }

  if (isOAuthAuthorizationActive(authorization)) {
    return authorization;
  }

  await updateOAuthRecord({
    fileStore: params.fileStore,
    serverId: params.serverId,
    update: (current) => stripOAuthAuthorizationState(current),
  });

  return undefined;
}

export async function getSavedOAuthAuthorizationByLocalAuthState(params: {
  fileStore: MetaMcpFileStore;
  localAuthState: string;
}): Promise<{ serverId: string; authorization: OAuthAuthorizationState } | undefined> {
  const authStore = await params.fileStore.loadAuthStore();

  for (const [serverId, record] of Object.entries(authStore.oauth)) {
    const authorization = record.authorization;
    if (!authorization || authorization.localAuthState !== params.localAuthState) {
      continue;
    }

    if (isOAuthAuthorizationActive(authorization)) {
      return { serverId, authorization };
    }

    await updateOAuthRecord({
      fileStore: params.fileStore,
      serverId,
      update: (current) => stripOAuthAuthorizationState(current),
    });
    return undefined;
  }

  return undefined;
}

export async function beginOAuthAuthorization(params: {
  server: ServerConfig;
  fileStore: MetaMcpFileStore;
  publicBaseUrl: string;
}): Promise<OAuthAuthorizationState> {
  const existingAuthorization = await getSavedOAuthAuthorization({
    fileStore: params.fileStore,
    serverId: params.server.id,
  });
  const redirectUrl = buildOAuthRedirectUrl({
    publicBaseUrl: params.publicBaseUrl,
    server: params.server,
  });

  if (existingAuthorization && existingAuthorization.redirectUrl === redirectUrl) {
    return existingAuthorization;
  }

  await updateOAuthRecord({
    fileStore: params.fileStore,
    serverId: params.server.id,
    update: (current) => stripOAuthAuthorizationState(current),
  });

  let nextAuthorization: OAuthAuthorizationState | undefined;
  const provider = createOAuthClientProvider({
    server: params.server,
    fileStore: params.fileStore,
    publicBaseUrl: params.publicBaseUrl,
    redirectUrlOverride: redirectUrl,
    onRedirect: (authorizationUrl) => {
      nextAuthorization = createOAuthAuthorizationState({
        providerAuthUrl: authorizationUrl.toString(),
        publicBaseUrl: params.publicBaseUrl,
        redirectUrl,
      });
    },
  });

  try {
    await auth(provider, {
      serverUrl: params.server.url,
      scope: supportsOAuth(params.server) ? getOAuthAuthConfig(params.server).scope : undefined,
    });
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) {
      throw error;
    }
  }

  if (!nextAuthorization) {
    throw new MetaMcpError(
      "OAUTH_AUTHORIZATION_NOT_STARTED",
      "OAuth authorization did not produce a redirect URL",
      {
        serverId: params.server.id,
      },
    );
  }

  await updateOAuthRecord({
    fileStore: params.fileStore,
    serverId: params.server.id,
    update: (current) => ({
      ...current,
      authorization: nextAuthorization,
    }),
  });

  return nextAuthorization;
}

export async function completeOAuthAuthorization(params: {
  server: ServerConfig;
  fileStore: MetaMcpFileStore;
  publicBaseUrl: string;
  authorizationCode: string;
}): Promise<void> {
  const authorization = await getSavedOAuthAuthorization({
    fileStore: params.fileStore,
    serverId: params.server.id,
  });
  if (!authorization) {
    throw new MetaMcpError(
      "OAUTH_AUTHORIZATION_NOT_COMPLETED",
      "OAuth callback is missing a live saved auth state. Start OAuth again and complete the latest browser flow within 15 minutes.",
      {
        serverId: params.server.id,
      },
    );
  }

  const provider = createOAuthClientProvider({
    server: params.server,
    fileStore: params.fileStore,
    publicBaseUrl: params.publicBaseUrl,
    redirectUrlOverride: authorization.redirectUrl,
  });

  let result;
  try {
    result = await auth(provider, {
      serverUrl: params.server.url,
      authorizationCode: params.authorizationCode,
      scope: supportsOAuth(params.server) ? getOAuthAuthConfig(params.server).scope : undefined,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message ===
        "Existing OAuth client information is required when exchanging an authorization code"
    ) {
      throw new MetaMcpError(
        "OAUTH_AUTHORIZATION_NOT_COMPLETED",
        "OAuth callback is missing the saved client registration. Start OAuth again and complete the latest browser flow.",
        {
          serverId: params.server.id,
          callbackUrl: authorization.callbackUrl,
        },
      );
    }

    if (
      error instanceof Error &&
      error.message.includes("Invalid OAuth error response") &&
      error.message.includes("[object Response]")
    ) {
      throw new MetaMcpError(
        "OAUTH_AUTHORIZATION_NOT_COMPLETED",
        "OAuth token exchange failed with an invalid error response from the provider. Start OAuth again. If it keeps failing, inspect the upstream OAuth callback/token response.",
        {
          serverId: params.server.id,
          callbackUrl: authorization.callbackUrl,
        },
      );
    }

    throw error;
  }

  if (result !== "AUTHORIZED") {
    throw new MetaMcpError(
      "OAUTH_AUTHORIZATION_NOT_COMPLETED",
      "OAuth authorization did not complete",
      {
        serverId: params.server.id,
      },
    );
  }

  await updateOAuthRecord({
    fileStore: params.fileStore,
    serverId: params.server.id,
    update: (current) => ({
      ...current,
      authorization: undefined,
      codeVerifier: undefined,
      discoveryState: undefined,
    }),
  });
}

export async function resolveHeaders(params: {
  server: ServerConfig;
  authStore: AuthStore;
}): Promise<Headers> {
  const headers = new Headers();
  const { server, authStore } = params;

  if (server.auth.type === "none" || server.auth.type === "auto") {
    return headers;
  }

  if (server.auth.type === "bearer") {
    const token = process.env[server.auth.env];
    if (!token) {
      throw new MetaMcpError(
        "MISSING_BEARER_TOKEN",
        `Missing bearer token for server '${server.id}'`,
        {
          serverId: server.id,
          envKey: server.auth.env,
        },
      );
    }

    headers.set("authorization", `Bearer ${token}`);
    return headers;
  }

  const oauthToken = getOAuthRecord(authStore, server.id);
  if (!oauthToken.accessToken) {
    throw new MetaMcpError("OAUTH_REQUIRED", `OAuth required for server '${server.id}'`, {
      serverId: server.id,
    });
  }

  headers.set("authorization", `Bearer ${oauthToken.accessToken}`);
  return headers;
}

export function getOAuthCallbackUrl(params: {
  publicBaseUrl: string;
  server: ServerConfig;
}): string {
  return buildOAuthRedirectUrl(params);
}
