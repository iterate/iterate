import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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
import { z } from "zod/v4";
import { MetaMcpError } from "../errors.ts";
import {
  MetaMcpServersFile,
  type OAuthAuthorizationState,
  type OAuthStoreRecord,
  type ServerConfig,
} from "../config/schema.ts";
import { serviceEnv } from "../env.ts";

const OAUTH_AUTHORIZATION_TTL_MS = 15 * 60 * 1000;

export const OAuthState = z.object({
  stateIdentifier: z.string(),
  serverId: z.string(),
  expiresAt: z.string(),
  authenticationUrl: z.string(),
});

export type OAuthState = z.infer<typeof OAuthState>;

const OAuthClientInformationRecord = z.looseObject({
  client_id: z.string().min(1),
  client_secret: z.string().optional(),
  client_id_issued_at: z.number().optional(),
  client_secret_expires_at: z.number().optional(),
});

const OAuthResourceMetadataRecord = z.looseObject({
  resource: z.string(),
  authorization_servers: z.array(z.string().url()).optional(),
});

const OAuthAuthorizationServerRecord = z.looseObject({
  issuer: z.string(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
});

const OAuthDiscoveryStateRecord = z.looseObject({
  authorizationServerUrl: z.string().url(),
  authorizationServerMetadata: OAuthAuthorizationServerRecord.optional(),
  resourceMetadata: OAuthResourceMetadataRecord.optional(),
  resourceMetadataUrl: z.string().url().optional(),
});

const OAuthTokenRecord = z.looseObject({
  accessToken: z.string().min(1).optional(),
  refreshToken: z.string().optional(),
  expiresAt: z.string().optional(),
  tokenType: z.string().optional(),
  scopes: z.array(z.string()).optional(),
});

const OAuthRuntimeRecord = z.object({
  authorization: z
    .object({
      authUrl: z.string().url(),
      providerAuthUrl: z.string().url().optional(),
      callbackUrl: z.string().url(),
      redirectUrl: z.string().url(),
      localAuthState: z.string().min(1).optional(),
      expiresAt: z.string(),
    })
    .optional(),
  codeVerifier: z.string().optional(),
  discoveryState: OAuthDiscoveryStateRecord.optional(),
});

const AuthFileContents = z.object({
  version: z.literal("1.0.0").default("1.0.0"),
  oauth: z.record(z.string(), OAuthRuntimeRecord).default({}),
  clientInformation: z.record(z.string(), OAuthClientInformationRecord).default({}),
  tokens: z.record(z.string(), OAuthTokenRecord).default({}),
});

type AuthFileContents = z.infer<typeof AuthFileContents>;

function getServersPath() {
  return serviceEnv.META_MCP_SERVICE_SERVERS_PATH;
}

function getAuthPath() {
  return serviceEnv.META_MCP_SERVICE_AUTH_PATH;
}

function getPublicBaseUrl() {
  return serviceEnv.META_MCP_SERVICE_PUBLIC_URL.toString();
}

function digestForLog(value: string | undefined): string | null {
  if (!value) return null;
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

async function nodeRealmFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
}

function isOAuthAuthorizationActive(authorization?: OAuthAuthorizationState): boolean {
  if (!authorization) {
    return false;
  }

  return new Date(authorization.expiresAt).getTime() > Date.now();
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

function buildOAuthCallbackUrl(params: { publicBaseUrl: string }): string {
  return new URL("/auth/finish", params.publicBaseUrl).toString();
}

function buildLocalOAuthStartUrl(params: { publicBaseUrl: string; authState: string }): string {
  return new URL(`/auth/start/${params.authState}`, params.publicBaseUrl).toString();
}

function createOAuthAuthorizationState(params: {
  providerAuthUrl: string;
  publicBaseUrl: string;
  redirectUrl: string;
  localAuthState: string;
}): OAuthAuthorizationState {
  return {
    authUrl: buildLocalOAuthStartUrl({
      publicBaseUrl: params.publicBaseUrl,
      authState: params.localAuthState,
    }),
    providerAuthUrl: params.providerAuthUrl,
    callbackUrl: params.redirectUrl,
    redirectUrl: params.redirectUrl,
    localAuthState: params.localAuthState,
    expiresAt: new Date(Date.now() + OAUTH_AUTHORIZATION_TTL_MS).toISOString(),
  };
}

function stripOAuthAuthorizationState(record: OAuthStoreRecord): OAuthStoreRecord {
  return {
    ...record,
    authorization: undefined,
    codeVerifier: undefined,
    discoveryState: undefined,
  };
}

function toOAuthState(serverId: string, authorization: OAuthAuthorizationState): OAuthState {
  return {
    stateIdentifier: authorization.localAuthState ?? "",
    serverId,
    expiresAt: authorization.expiresAt,
    authenticationUrl: authorization.providerAuthUrl ?? authorization.authUrl,
  };
}

class FileBackedOAuthClientProvider implements OAuthClientProvider {
  private readonly oauthState = randomUUID();

  constructor(
    private readonly params: {
      server: ServerConfig;
      authManager: AuthManager;
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
    return await this.params.authManager.getClientInformation(this.params.server.id);
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.params.authManager.updateAuthFile((authFile) => ({
      ...authFile,
      clientInformation: {
        ...authFile.clientInformation,
        [this.params.server.id]: clientInformation,
      },
    }));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return await this.params.authManager.getTokens(this.params.server.id);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.params.authManager.updateAuthFile((authFile) => ({
      ...authFile,
      tokens: {
        ...authFile.tokens,
        [this.params.server.id]: fromOAuthTokens(tokens),
      },
    }));
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.params.onRedirect?.(authorizationUrl);
  }

  async state(): Promise<string> {
    return this.oauthState;
  }

  getLocalAuthState(): string {
    return this.oauthState;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.params.authManager.updateOAuthRecord({
      serverId: this.params.server.id,
      update: (current) => ({
        ...current,
        codeVerifier,
      }),
    });
  }

  async codeVerifier(): Promise<string> {
    const codeVerifier = (await this.params.authManager.getOAuthRecord(this.params.server.id))
      .codeVerifier;
    if (!codeVerifier) {
      throw new MetaMcpError("OAUTH_MISSING_CODE_VERIFIER", "Missing OAuth code verifier", {
        serverId: this.params.server.id,
      });
    }

    return codeVerifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.params.authManager.updateOAuthRecord({
      serverId: this.params.server.id,
      update: (current) => ({
        ...current,
        discoveryState: state,
      }),
    });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const record = await this.params.authManager.getOAuthRecord(this.params.server.id);
    return record.discoveryState as OAuthDiscoveryState | undefined;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    await this.params.authManager.updateOAuthRecord({
      serverId: this.params.server.id,
      update: (current) => {
        if (scope === "all") {
          return {};
        }

        return {
          ...current,
          ...(scope === "verifier" ? { codeVerifier: undefined } : {}),
          ...(scope === "discovery" ? { discoveryState: undefined } : {}),
        };
      },
    });

    if (scope === "all" || scope === "client") {
      await this.params.authManager.updateAuthFile((authFile) => {
        const clientInformation = { ...authFile.clientInformation };
        delete clientInformation[this.params.server.id];
        return {
          ...authFile,
          clientInformation,
        };
      });
    }

    if (scope === "all" || scope === "tokens") {
      await this.params.authManager.updateAuthFile((authFile) => {
        const tokens = { ...authFile.tokens };
        delete tokens[this.params.server.id];
        return {
          ...authFile,
          tokens,
        };
      });
    }
  }
}

export class AuthManager {
  constructor(
    private readonly params: {
      serversPath?: string;
      authPath?: string;
      publicBaseUrl?: string;
    } = {},
  ) {}

  private async loadServersFile(): Promise<z.infer<typeof MetaMcpServersFile>> {
    return await readFile(this.params.serversPath ?? getServersPath(), "utf-8")
      .then(JSON.parse)
      .catch(() => ({ servers: [] }))
      .then((value) => MetaMcpServersFile.parse(value));
  }

  private async loadAuthFile(): Promise<AuthFileContents> {
    const authPath = this.params.authPath ?? getAuthPath();
    return await readFile(authPath, "utf-8")
      .then(JSON.parse)
      .catch(() => ({}))
      .then((value) => AuthFileContents.parse(value))
      .catch(() => {
        console.error(`Failed to parse auth file at ${authPath}, resetting to empty object`);
        return AuthFileContents.parse({
          version: "1.0.0" as const,
          oauth: {},
          clientInformation: {},
          tokens: {},
        });
      });
  }

  private async saveAuthFile(authFile: AuthFileContents) {
    await writeFile(this.params.authPath ?? getAuthPath(), JSON.stringify(authFile, null, 2));
  }

  async updateAuthFile(update: (authFile: AuthFileContents) => AuthFileContents) {
    const authFile = await this.loadAuthFile();
    await this.saveAuthFile(update(authFile));
  }

  async getOAuthRecord(serverId: string): Promise<OAuthStoreRecord> {
    const authFile = await this.loadAuthFile();
    return authFile.oauth[serverId] ?? {};
  }

  async getClientInformation(serverId: string): Promise<OAuthClientInformationMixed | undefined> {
    const authFile = await this.loadAuthFile();
    return authFile.clientInformation[serverId];
  }

  async getTokens(serverId: string): Promise<OAuthTokens | undefined> {
    const authFile = await this.loadAuthFile();
    return toOAuthTokens(authFile.tokens[serverId] ?? {});
  }

  async updateOAuthRecord(params: {
    serverId: string;
    update: (current: OAuthStoreRecord) => OAuthStoreRecord;
  }) {
    await this.updateAuthFile((authFile) => ({
      ...authFile,
      oauth: {
        ...authFile.oauth,
        [params.serverId]: params.update(authFile.oauth[params.serverId] ?? {}),
      },
    }));
  }

  private async getServer(serverId: string): Promise<ServerConfig> {
    const server = (await this.loadServersFile()).servers.find((entry) => entry.id === serverId);
    if (!server) {
      throw new MetaMcpError("SERVER_NOT_FOUND", `Server '${serverId}' not found`, { serverId });
    }

    return server;
  }

  public createOAuthClientProvider(params: {
    server: ServerConfig;
    redirectUrl: string;
    onRedirect?: (authorizationUrl: URL) => void;
  }) {
    return new FileBackedOAuthClientProvider({
      server: params.server,
      authManager: this,
      redirectUrl: params.redirectUrl,
      onRedirect: params.onRedirect,
    });
  }

  public async beginOAuthAuthorization(server: ServerConfig): Promise<OAuthAuthorizationState> {
    if (!supportsOAuth(server)) {
      throw new MetaMcpError("INVALID_CONFIG", `Server '${server.id}' does not use OAuth`, {
        serverId: server.id,
      });
    }

    const existingAuthorization = (await this.getOAuthRecord(server.id)).authorization;
    if (existingAuthorization && isOAuthAuthorizationActive(existingAuthorization)) {
      return existingAuthorization;
    }

    const redirectUrl = buildOAuthCallbackUrl({
      publicBaseUrl: this.params.publicBaseUrl ?? getPublicBaseUrl(),
    });

    await this.updateOAuthRecord({
      serverId: server.id,
      update: (current) => stripOAuthAuthorizationState(current),
    });

    let nextAuthorization: OAuthAuthorizationState | undefined;
    const provider = this.createOAuthClientProvider({
      server,
      redirectUrl,
      onRedirect: (authorizationUrl) => {
        nextAuthorization = createOAuthAuthorizationState({
          providerAuthUrl: authorizationUrl.toString(),
          publicBaseUrl: this.params.publicBaseUrl ?? getPublicBaseUrl(),
          redirectUrl,
          localAuthState: provider.getLocalAuthState(),
        });
      },
    });

    try {
      await auth(provider, {
        serverUrl: server.url,
        scope: getOAuthAuthConfig(server).scope,
        fetchFn: nodeRealmFetch,
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
        { serverId: server.id },
      );
    }

    const providerAuthUrl = new URL(nextAuthorization.providerAuthUrl ?? nextAuthorization.authUrl);
    console.info(
      "[meta-mcp-auth] begin",
      JSON.stringify({
        serverId: server.id,
        localAuthState: nextAuthorization.localAuthState,
        providerState: providerAuthUrl.searchParams.get("state"),
        codeChallengeDigest: digestForLog(
          providerAuthUrl.searchParams.get("code_challenge") ?? undefined,
        ),
        codeVerifierDigest: digestForLog((await this.getOAuthRecord(server.id)).codeVerifier),
      }),
    );

    await this.updateOAuthRecord({
      serverId: server.id,
      update: (current) => ({
        ...current,
        authorization: nextAuthorization,
      }),
    });

    return nextAuthorization;
  }

  public async startOAuthAuthorization(serverId: string): Promise<OAuthState> {
    const server = await this.getServer(serverId);
    const authorization = await this.beginOAuthAuthorization(server);
    return toOAuthState(serverId, authorization);
  }

  public async saveOAuthSate(state: OAuthState) {
    const parsedState = OAuthState.parse(state);
    await this.updateOAuthRecord({
      serverId: parsedState.serverId,
      update: (current) => ({
        ...current,
        authorization: {
          authUrl: buildLocalOAuthStartUrl({
            publicBaseUrl: this.params.publicBaseUrl ?? getPublicBaseUrl(),
            authState: parsedState.stateIdentifier,
          }),
          providerAuthUrl: parsedState.authenticationUrl,
          callbackUrl: buildOAuthCallbackUrl({
            publicBaseUrl: this.params.publicBaseUrl ?? getPublicBaseUrl(),
          }),
          redirectUrl: buildOAuthCallbackUrl({
            publicBaseUrl: this.params.publicBaseUrl ?? getPublicBaseUrl(),
          }),
          localAuthState: parsedState.stateIdentifier,
          expiresAt: parsedState.expiresAt,
        },
      }),
    });
  }

  public async getOAuthSate(stateIdentifier: string): Promise<OAuthState | null> {
    const authFile = await this.loadAuthFile();

    for (const [serverId, record] of Object.entries(authFile.oauth)) {
      const authorization = record.authorization;
      if (!authorization || authorization.localAuthState !== stateIdentifier) {
        continue;
      }

      if (!isOAuthAuthorizationActive(authorization)) {
        await this.updateOAuthRecord({
          serverId,
          update: (current) => stripOAuthAuthorizationState(current),
        });
        return null;
      }

      return toOAuthState(serverId, authorization);
    }

    return null;
  }

  public async finishOAuthAuthorization(
    stateIdentifier: string,
    code: string,
  ): Promise<{ success: boolean; message: string }> {
    const savedState = await this.getOAuthSate(stateIdentifier);
    if (!savedState) {
      return { success: false, message: "No saved state found for the given state identifier" };
    }

    const server = await this.getServer(savedState.serverId);
    const authorization = (await this.getOAuthRecord(savedState.serverId)).authorization;
    if (!authorization) {
      return { success: false, message: "Missing saved OAuth authorization" };
    }

    const provider = this.createOAuthClientProvider({
      server,
      redirectUrl: authorization.redirectUrl,
    });

    console.info(
      "[meta-mcp-auth] finish",
      JSON.stringify({
        serverId: savedState.serverId,
        stateIdentifier,
        providerState: authorization.providerAuthUrl
          ? new URL(authorization.providerAuthUrl).searchParams.get("state")
          : null,
        codeVerifierDigest: digestForLog(
          (await this.getOAuthRecord(savedState.serverId)).codeVerifier,
        ),
      }),
    );

    const result = await auth(provider, {
      serverUrl: server.url,
      authorizationCode: code,
      scope: getOAuthAuthConfig(server).scope,
      fetchFn: nodeRealmFetch,
    });

    if (result !== "AUTHORIZED") {
      return { success: false, message: "OAuth authorization did not complete" };
    }

    await this.updateOAuthRecord({
      serverId: savedState.serverId,
      update: (current) => ({
        ...current,
        authorization: undefined,
        codeVerifier: undefined,
        discoveryState: undefined,
      }),
    });

    return {
      success: true,
      message: `${savedState.serverId} is now authorized for Meta MCP. You can close this tab and return to the daemon.`,
    };
  }

  public async completeOAuthAuthorization(params: {
    server: ServerConfig;
    authorizationCode: string;
  }): Promise<void> {
    const authorization = (await this.getOAuthRecord(params.server.id)).authorization;
    if (!authorization) {
      throw new MetaMcpError(
        "OAUTH_AUTHORIZATION_NOT_COMPLETED",
        "OAuth callback is missing a live saved auth state. Start OAuth again and complete the latest browser flow within 15 minutes.",
        {
          serverId: params.server.id,
        },
      );
    }

    const provider = this.createOAuthClientProvider({
      server: params.server,
      redirectUrl: authorization.redirectUrl,
    });

    const result = await auth(provider, {
      serverUrl: params.server.url,
      authorizationCode: params.authorizationCode,
      scope: getOAuthAuthConfig(params.server).scope,
      fetchFn: nodeRealmFetch,
    });

    if (result !== "AUTHORIZED") {
      throw new MetaMcpError(
        "OAUTH_AUTHORIZATION_NOT_COMPLETED",
        "OAuth authorization did not complete",
        {
          serverId: params.server.id,
        },
      );
    }

    await this.updateOAuthRecord({
      serverId: params.server.id,
      update: (current) => ({
        ...current,
        authorization: undefined,
        codeVerifier: undefined,
        discoveryState: undefined,
      }),
    });
  }

  public async resolveHeaders(server: ServerConfig): Promise<Headers> {
    const headers = new Headers();

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

    const tokens = await this.getTokens(server.id);
    if (!tokens?.access_token) {
      throw new MetaMcpError("OAUTH_REQUIRED", `OAuth required for server '${server.id}'`, {
        serverId: server.id,
      });
    }

    headers.set("authorization", `Bearer ${tokens.access_token}`);
    return headers;
  }
}
