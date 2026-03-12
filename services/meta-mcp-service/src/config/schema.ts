import { z } from "zod/v4";

const oauthAuthFieldsSchema = {
  scope: z.string().min(1).optional(),
  clientName: z.string().min(1).optional(),
  clientUri: z.url().optional(),
  clientMetadataUrl: z.url().optional(),
};

export const ServiceEnv = z.object({
  META_MCP_SERVICE_HOST: z.string().default("0.0.0.0"),
  META_MCP_SERVICE_PORT: z.coerce.number().int().min(1).max(65535).default(19070),
  META_MCP_SERVICE_PUBLIC_URL: z.url().optional(),
  META_MCP_SERVICE_SERVERS_PATH: z.string().optional(),
  META_MCP_SERVICE_CONFIG_PATH: z.string().optional(),
  META_MCP_SERVICE_AUTH_PATH: z.string().optional(),
});

export const AuthConfig = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("none"),
  }),
  z.object({
    type: z
      .literal("auto")
      .describe(
        "Default. Try the server without auth first, then fall back to OAuth if the server asks for it.",
      ),
    ...oauthAuthFieldsSchema,
  }),
  z.object({
    type: z.literal("bearer"),
    env: z.string().min(1),
  }),
  z.object({
    type: z.literal("oauth"),
    ...oauthAuthFieldsSchema,
  }),
]);

const AuthInput = z.union([AuthConfig, z.enum(["auto", "oauth", "none"])]);

export const ServerConfig = z.object({
  id: z.string().min(1).describe("Stable server id used in config and OAuth state."),
  url: z.string().url().describe("Base URL for the remote MCP server."),
  namespace: z
    .string()
    .min(1)
    .optional()
    .describe("Optional namespace override for discovered tools. Defaults to the server id."),
  enabled: z.boolean().default(true).describe("Whether this server should be available right now."),
  auth: AuthConfig.default({ type: "auto" }).describe(
    "Optional auth config. Defaults to auto: no auth first, then OAuth if needed.",
  ),
});

export const ServerInput = z.object({
  id: z
    .string()
    .min(1)
    .describe(
      "Required stable server id used in config and OAuth state. If you need to choose one, derive a short slug from the URL hostname, for example posthog or cloudflare-observability.",
    ),
  url: z.string().url().describe("Base URL for the remote MCP server."),
  transport: z
    .enum(["streamable-http", "auto"])
    .default("auto")
    .describe("Transport mode. Leave as auto unless you know you need streamable-http."),
  namespace: z
    .string()
    .min(1)
    .optional()
    .describe("Optional namespace override for discovered tools. Defaults to the server id."),
  enabled: z
    .boolean()
    .default(true)
    .describe("Whether the new server should be enabled immediately."),
  auth: AuthConfig.optional().describe(
    'Optional. If omitted, Meta MCP uses auto auth: try no auth first, then OAuth if the server requires it. You can pass the shorthand string "auto", "oauth", or "none", or a full auth object such as { type: "oauth" } or { type: "bearer", env: "TOKEN_ENV" }. If the provider rejects the callback URL, set redirectBaseUrl to the browser-facing Meta MCP origin. Use bearer only when you explicitly know the token env var.',
  ),
});

export const ParsedServerInput = ServerInput.extend({
  auth: AuthInput.optional(),
});

export function normalizeServerInput(input: ParsedServerInput): ServerInput {
  return {
    ...input,
    auth: typeof input.auth === "string" ? { type: input.auth } : input.auth,
  };
}

export const MetaMcpServersFile = z.object({
  servers: z.array(ServerConfig).default([]),
});

const OAuthClientInformation = z
  .object({
    client_id: z.string().min(1),
    client_secret: z.string().optional(),
    client_id_issued_at: z.number().optional(),
    client_secret_expires_at: z.number().optional(),
  })
  .passthrough();

const OAuthAuthorizationServer = z
  .object({
    issuer: z.string(),
    authorization_endpoint: z.string().url(),
    token_endpoint: z.string().url(),
  })
  .passthrough();

const OAuthResourceMetadata = z
  .object({
    resource: z.string(),
    authorization_servers: z.array(z.string().url()).optional(),
  })
  .passthrough();

const OAuthDiscoveryState = z.object({
  authorizationServerUrl: z.string().url(),
  authorizationServerMetadata: OAuthAuthorizationServer.optional(),
  resourceMetadata: OAuthResourceMetadata.optional(),
  resourceMetadataUrl: z.string().url().optional(),
});

export const OAuthAuthorizationState = z.object({
  authUrl: z.string().url(),
  providerAuthUrl: z.string().url().optional(),
  callbackUrl: z.string().url(),
  redirectUrl: z.string().url(),
  localAuthState: z.string().min(1).optional(),
  expiresAt: z.string(),
});

export const OAuthServerState = z.object({
  accessToken: z.string().min(1).optional(),
  refreshToken: z.string().optional(),
  expiresAt: z.string().optional(),
  tokenType: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  clientInformation: OAuthClientInformation.optional(),
  codeVerifier: z.string().optional(),
  discoveryState: OAuthDiscoveryState.optional(),
  authorization: OAuthAuthorizationState.optional(),
});

export const MetaMcpAuthFile = z.object({
  oauth: z.record(z.string(), OAuthServerState).default({}),
});

export const MetaMcpConfig = MetaMcpServersFile;
export const AuthStore = MetaMcpAuthFile;
export const OAuthStoreRecord = OAuthServerState;

export type AuthStore = z.infer<typeof MetaMcpAuthFile>;
export type MetaMcpAuthFile = z.infer<typeof MetaMcpAuthFile>;
export type MetaMcpConfig = z.infer<typeof MetaMcpServersFile>;
export type MetaMcpServersFile = z.infer<typeof MetaMcpServersFile>;
export type OAuthAuthorizationState = z.infer<typeof OAuthAuthorizationState>;
export type OAuthStoreRecord = z.infer<typeof OAuthServerState>;
export type OAuthServerState = z.infer<typeof OAuthServerState>;
export type ServerConfig = z.infer<typeof ServerConfig>;
export type ServerInput = z.infer<typeof ServerInput>;
export type ParsedServerInput = z.infer<typeof ParsedServerInput>;
