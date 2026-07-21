// Outbound MCP-server OAuth: the flow behind `itx.mcp.beginOAuth`.
//
// An agent that discovers an OAuth-protected MCP server (Cloudflare's
// mcp.cloudflare.com, the dummy-petshop /mcp, …) cannot paste a token — there
// is none until a human signs in. beginMcpOAuth turns the server URL into a
// one-click authorization link:
//
//   1. Discover the server's OAuth metadata — RFC 9728 protected-resource
//      (probed off the /mcp `WWW-Authenticate: …resource_metadata=` pointer,
//      falling back to the well-known path) → the RFC 8414 authorization-server
//      metadata it names.
//   2. Dynamically register a PUBLIC client (RFC 7591, token_endpoint_auth_method
//      "none") whose one redirect URI is this deployment's /api/mcp-oauth/callback.
//      Public + PKCE is the standard MCP client shape (no client secret to guard).
//   3. Build the authorization-code + PKCE (S256) URL and fold what the callback
//      needs — the auth server, the resource, the client id, the PKCE verifier,
//      the target secret path, the agent to notify — into a state token.
//
// The state is ENCRYPTED (AES-GCM with SECRET_ENCRYPTION_KEY), not merely signed:
// for a public client the PKCE verifier is the ONLY thing protecting the
// authorization code, so it must not ride in a readable token. Nothing bulky or
// re-derivable lives in it — the auth-server metadata is re-discovered at
// completion rather than carried.
//
// The user signs in at the provider, which redirects to /api/mcp-oauth/callback,
// where completeMcpOAuth redeems the code for tokens and hands back a secret
// spec: material `{ accessToken, refreshToken?, clientId }`, egress pinned to the
// MCP + token endpoints, and the shared oauth-refresh-token strategy
// (`clientCreds: "material"`) so the Secret DO re-mints on 401 in its own trusted
// code. The agent then connects like any bearer MCP:
//   itx.mcp.connect({ url, headers: { authorization:
//     'Bearer getSecret("<path>", { field: "accessToken" })' } })
//
// The two verbs are pure — key + fetch function in, data out — so the whole round
// trip unit-tests with no network. rpc-targets.ts (begin) and integration-api.ts
// (callback) are the thin adapters that supply itx bindings, write the Secret DO,
// and message the agent.

import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  extractResourceMetadataUrl,
  registerClient,
  resourceUrlFromServerUrl,
  startAuthorization,
  type AuthorizationServerMetadata,
  type FetchLike,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { decryptSecretMaterial, encryptSecretMaterial } from "../secrets/crypto.ts";
import type { SecretRefresh } from "../secrets/types.ts";

/** How long an authorization link is good for. Long enough for a human to sign
 * in at the provider, short enough that a leaked (already-encrypted) link is
 * not a standing credential. */
const STATE_TTL_MS = 15 * 60 * 1000;

const CLIENT_NAME = "iterate";

/** A message meant for a human (agent or dashboard) — thrown when the flow
 * cannot proceed and the reason is worth surfacing verbatim. */
export class McpOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpOAuthError";
  }
}

// The encrypted state carried through the redirect. Only what the callback
// cannot cheaply re-derive: the routing/target data, the resource indicator, the
// registered client id, and the PKCE verifier (the reason this is encrypted, not
// signed). The auth-server metadata is re-discovered at completion.
const MCPOAuthState = z.object({
  v: z.literal("mcp-oauth-1"),
  projectId: z.string(),
  path: z.string(),
  notify: z.string().optional(),
  mcpUrl: z.string(),
  resource: z.string().optional(),
  redirectUri: z.string(),
  authServerUrl: z.string(),
  clientId: z.string(),
  codeVerifier: z.string(),
  expiresAt: z.number(),
});
type MCPOAuthState = z.infer<typeof MCPOAuthState>;

type BeginMcpOAuthInput = {
  /** The MCP server's streamable-HTTP URL (what itx.mcp.connect would take). */
  mcpUrl: string;
  /** Normalized `/secrets/…` path the resulting token lands at. */
  path: string;
  /** The redirect URI to register — this deployment's /api/mcp-oauth/callback. */
  redirectUri: string;
  /** Agent path to message when the connection completes (absent for non-agent scopes). */
  notify?: string;
  /** OAuth scope to request; omitted means "server default". */
  scope?: string;
  projectId: string;
  /** SECRET_ENCRYPTION_KEY — encrypts the state token. */
  encryptionKey: string;
  /** Outbound fetch (project egress in production; a test server in unit tests). */
  fetchFn: FetchLike;
};

type BeginMcpOAuthResult = {
  /** The provider authorization URL to send the user to. */
  authorizationUrl: string;
  /** The secret path the token will land at (echoed for convenience). */
  path: string;
};

export async function beginMcpOAuth(input: BeginMcpOAuthInput): Promise<BeginMcpOAuthResult> {
  const { fetchFn } = input;
  if (!isHttpUrl(input.mcpUrl)) {
    throw new McpOAuthError(`${input.mcpUrl} is not an http(s) URL.`);
  }

  // 1. Protected-resource metadata (RFC 9728). Prefer the pointer the server
  //    hands out in its 401 WWW-Authenticate; fall back to the well-known path.
  const resourceMetadataUrl = await probeResourceMetadataUrl(input.mcpUrl, fetchFn);
  const prm = await discoverOAuthProtectedResourceMetadata(
    input.mcpUrl,
    resourceMetadataUrl ? { resourceMetadataUrl } : {},
    fetchFn,
  ).catch((cause: unknown) => {
    throw new McpOAuthError(
      `${input.mcpUrl} is not an OAuth-protected MCP server (no protected-resource metadata: ${errorText(cause)}). ` +
        `If it takes a bearer token you already hold, use itx.secrets.collectFromUser instead.`,
    );
  });
  const authServerUrl = prm.authorization_servers?.[0]?.toString();
  if (!authServerUrl) {
    throw new McpOAuthError(`${input.mcpUrl} does not advertise an OAuth authorization server.`);
  }

  const authMetadata = await discoverOrThrow(authServerUrl, fetchFn);
  if (!authMetadata.registration_endpoint) {
    throw new McpOAuthError(
      `${authServerUrl} does not support dynamic client registration, so this automated flow ` +
        `cannot obtain a client. Register a client out of band and store its token with itx.secrets.collectFromUser.`,
    );
  }

  // 2. Dynamic client registration (RFC 7591): a PUBLIC client (no secret) whose
  //    one redirect URI is our callback. Public + PKCE is the standard MCP shape.
  const clientInfo = await registerClient(authServerUrl, {
    metadata: authMetadata,
    clientMetadata: {
      client_name: CLIENT_NAME,
      redirect_uris: [input.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(input.scope ? { scope: input.scope } : {}),
    },
    ...(input.scope ? { scope: input.scope } : {}),
    fetchFn,
  }).catch((cause: unknown) => {
    throw new McpOAuthError(
      `${authServerUrl} rejected dynamic client registration: ${errorText(cause)}`,
    );
  });

  // 3. Authorization-code + PKCE URL. The resource indicator (RFC 8707) binds
  //    the eventual token to this MCP server.
  const resource = resourceUrlFromServerUrl(prm.resource ?? input.mcpUrl);
  const { authorizationUrl, codeVerifier } = await startAuthorization(authServerUrl, {
    metadata: authMetadata,
    clientInformation: clientInfo,
    redirectUrl: input.redirectUri,
    ...(input.scope ? { scope: input.scope } : {}),
    ...(resource ? { resource } : {}),
  });

  const state: MCPOAuthState = {
    v: "mcp-oauth-1",
    projectId: input.projectId,
    path: input.path,
    ...(input.notify ? { notify: input.notify } : {}),
    mcpUrl: input.mcpUrl,
    ...(resource ? { resource: resource.toString() } : {}),
    redirectUri: input.redirectUri,
    authServerUrl,
    clientId: clientInfo.client_id,
    codeVerifier,
    expiresAt: Date.now() + STATE_TTL_MS,
  };
  const encryptedState = await encryptSecretMaterial(JSON.stringify(state), input.encryptionKey);
  authorizationUrl.searchParams.set("state", toBase64Url(JSON.stringify(encryptedState)));

  return { authorizationUrl: authorizationUrl.toString(), path: input.path };
}

type CompleteMcpOAuthResult = {
  path: string;
  notify?: string;
  mcpUrl: string;
  /** The Secret DO update the caller applies: material + egress + refresh. */
  secret: {
    material: Record<string, string>;
    egress: { urls: string[] };
    /** null (never undefined) so an update REPLACES any stale strategy on the path. */
    refresh: SecretRefresh | null;
  };
};

/**
 * Redeem the callback's authorization code for tokens and produce the Secret DO
 * update. Takes the already-decoded state (the callback decodes once to route by
 * projectId), re-discovers the auth-server metadata (kept out of the state), and
 * exchanges as a public PKCE client.
 */
export async function completeMcpOAuth(
  state: MCPOAuthState,
  input: { code: string; iss?: string; fetchFn: FetchLike },
): Promise<CompleteMcpOAuthResult> {
  const authMetadata = await discoverOrThrow(state.authServerUrl, input.fetchFn);
  const tokenEndpoint = authMetadata.token_endpoint;

  const tokens = await exchangeAuthorization(state.authServerUrl, {
    metadata: authMetadata,
    clientInformation: { client_id: state.clientId },
    authorizationCode: input.code,
    codeVerifier: state.codeVerifier,
    redirectUri: state.redirectUri,
    ...(state.resource ? { resource: new URL(state.resource) } : {}),
    ...(input.iss ? { iss: input.iss } : {}),
    fetchFn: input.fetchFn,
  }).catch((cause: unknown) => {
    throw new McpOAuthError(`token exchange failed: ${errorText(cause)}`);
  });

  // The access token is sent as a bearer to the MCP server; the refresh token is
  // POSTed to the token endpoint. Pin egress to exactly those two origins.
  const egressUrls = [...new Set([state.mcpUrl, tokenEndpoint].map((url) => new URL(url).origin))];

  return {
    path: state.path,
    ...(state.notify ? { notify: state.notify } : {}),
    mcpUrl: state.mcpUrl,
    secret: {
      material: {
        accessToken: tokens.access_token,
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        // client_id is required to refresh a public client (RFC 6749 §6).
        clientId: state.clientId,
      },
      egress: { urls: egressUrls },
      // A refresh token means the Secret DO can re-mint on 401 in trusted code.
      refresh: tokens.refresh_token
        ? { kind: "oauth-refresh-token", tokenEndpoint, clientCreds: "material" }
        : null,
    },
  };
}

/** Decrypt + validate a state token (throws McpOAuthError on a bad or expired
 * link). The callback decodes ONCE, reads `projectId` for routing, then hands the
 * decoded state to completeMcpOAuth — no second decrypt. */
export async function decodeMcpOAuthState(token: string, key: string): Promise<MCPOAuthState> {
  let json: string;
  try {
    const encrypted = JSON.parse(fromBase64Url(token));
    json = await decryptSecretMaterial(encrypted, key);
  } catch {
    throw new McpOAuthError(
      "this authorization link is malformed or was issued for another deployment.",
    );
  }
  const state = MCPOAuthState.parse(JSON.parse(json));
  if (state.expiresAt < Date.now()) {
    throw new McpOAuthError("this authorization link has expired — ask the agent for a fresh one.");
  }
  return state;
}

async function discoverOrThrow(
  authServerUrl: string,
  fetchFn: FetchLike,
): Promise<AuthorizationServerMetadata & { token_endpoint: string }> {
  const metadata = await discoverAuthorizationServerMetadata(authServerUrl, { fetchFn }).catch(
    (cause: unknown) => {
      throw new McpOAuthError(
        `could not discover OAuth metadata for ${authServerUrl}: ${errorText(cause)}`,
      );
    },
  );
  if (!metadata?.token_endpoint) {
    throw new McpOAuthError(`${authServerUrl} published no usable OAuth authorization metadata.`);
  }
  return metadata as AuthorizationServerMetadata & { token_endpoint: string };
}

/** POST a minimal initialize to /mcp so an OAuth-protected server answers 401
 * with its `WWW-Authenticate: …resource_metadata=` pointer (RFC 9728 §5.1).
 * Best-effort: any failure just means discovery falls back to the well-known
 * path. */
async function probeResourceMetadataUrl(
  mcpUrl: string,
  fetchFn: FetchLike,
): Promise<URL | undefined> {
  try {
    const response = await fetchFn(mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: CLIENT_NAME, version: "1.0.0" },
        },
      }),
    });
    return extractResourceMetadataUrl(response);
  } catch {
    return undefined;
  }
}

/** Adapt a Cloudflare Fetcher (project egress) to the SDK's FetchLike. Unlike
 * the MCP client's stateless adapter, this forwards GETs unchanged — OAuth
 * discovery reads the server's well-known metadata over GET. */
export function fetchLikeFromFetcher(fetcher: Fetcher): FetchLike {
  return (url, init) => fetcher.fetch(new Request(url as string | URL, init as RequestInit));
}

function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  return /^https?:$/.test(new URL(value).protocol);
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}
