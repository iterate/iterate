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
//   2. Dynamically register a confidential client (RFC 7591) whose one
//      redirect URI is this deployment's /api/mcp-oauth/callback.
//   3. Build the authorization-code + PKCE (S256) URL and fold everything the
//      callback will need — endpoints, the freshly registered client
//      credentials, the PKCE verifier, the target secret path, the agent to
//      notify — into an ENCRYPTED `state` token (it carries a client secret and
//      a PKCE verifier, so signing is not enough; we AES-GCM it with
//      SECRET_ENCRYPTION_KEY).
//
// The user clicks the link, signs in at the provider, and the provider
// redirects to /api/mcp-oauth/callback, where completeMcpOAuth redeems the code
// for tokens and hands back a secret spec: material `{ accessToken,
// refreshToken?, clientId?, clientSecret? }`, pinned egress (the MCP + token
// endpoints), and — for a confidential client — the shared oauth-refresh-token
// refresh strategy (`clientCreds: "material"`), so the Secret DO re-mints on
// 401 in its own trusted code. The agent then connects like any bearer MCP:
//   itx.mcp.connect({ url, headers: { authorization:
//     'Bearer getSecret({ path: "<path>", field: "accessToken" })' } })
//
// The two verbs are pure — they take the encryption key + a fetch function and
// return data — so the whole round trip unit-tests against the real petshop
// handler with no network. rpc-targets.ts (begin) and integration-api.ts
// (callback) are the thin adapters that supply itx bindings, write the Secret
// DO, and message the agent.

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

const CLIENT_NAME = "Iterate";

/** A message meant for a human (agent or dashboard) — thrown when the flow
 * cannot proceed and the reason is worth surfacing verbatim. */
export class McpOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpOAuthError";
  }
}

export type BeginMcpOAuthInput = {
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
  /** Outbound fetch (project egress in production; the petshop handler in tests). */
  fetchFn: FetchLike;
};

export type BeginMcpOAuthResult = {
  /** The provider authorization URL to send the user to. */
  authorizationUrl: string;
  /** The secret path the token will land at (echoed for convenience). */
  path: string;
  /** The authorization server the user will sign in at (for the agent's message). */
  authorizationServer: string;
};

export type CompleteMcpOAuthInput = {
  /** The encrypted `state` echoed back by the provider. */
  state: string;
  /** The authorization code from the callback query. */
  code: string;
  /** The `iss` callback param (RFC 9207), validated against discovery. */
  iss?: string;
  encryptionKey: string;
  fetchFn: FetchLike;
};

export type CompleteMcpOAuthResult = {
  path: string;
  notify?: string;
  mcpUrl: string;
  egressOrigins: string[];
  /** The Secret DO update the caller applies: material + egress + (maybe) refresh. */
  secret: {
    material: Record<string, string>;
    egress: { urls: string[] };
    refresh?: SecretRefresh;
  };
};

// The encrypted state carried through the redirect. Everything here is either
// public discovery data or a freshly minted per-flow secret (client secret,
// PKCE verifier) — which is exactly why the whole blob is encrypted, not just
// signed, before it rides in a URL the provider echoes back.
const MCPOAuthState = z.object({
  v: z.literal("mcp-oauth-1"),
  projectId: z.string(),
  path: z.string(),
  notify: z.string().optional(),
  mcpUrl: z.string(),
  resource: z.string().optional(),
  redirectUri: z.string(),
  authServerUrl: z.string(),
  tokenEndpoint: z.string(),
  /** Full RFC 8414 metadata, so the exchange picks the same client-auth method
   * discovery advertised without re-fetching. */
  authMetadata: z.unknown(),
  clientId: z.string(),
  clientSecret: z.string().optional(),
  codeVerifier: z.string(),
  egressOrigins: z.array(z.string()),
  expiresAt: z.number(),
});
type MCPOAuthState = z.infer<typeof MCPOAuthState>;

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

  // 2. Authorization-server metadata (RFC 8414).
  const authMetadata = await discoverAuthorizationServerMetadata(authServerUrl, { fetchFn }).catch(
    (cause: unknown) => {
      throw new McpOAuthError(
        `could not discover OAuth metadata for ${authServerUrl}: ${errorText(cause)}`,
      );
    },
  );
  if (!authMetadata) {
    throw new McpOAuthError(`${authServerUrl} published no usable OAuth authorization metadata.`);
  }
  if (!authMetadata.registration_endpoint) {
    throw new McpOAuthError(
      `${authServerUrl} does not support dynamic client registration, so this automated flow ` +
        `cannot obtain a client. Register a client out of band and store its token with itx.secrets.collectFromUser.`,
    );
  }
  const tokenEndpoint = authMetadata.token_endpoint;
  if (!tokenEndpoint) {
    throw new McpOAuthError(`${authServerUrl} published no token endpoint.`);
  }

  // 3. Dynamic client registration (RFC 7591): one client, whose one redirect
  //    URI is our callback. We ask for a confidential client so the token can
  //    later be refreshed with the shared oauth-refresh-token strategy.
  const clientInfo = await registerClient(authServerUrl, {
    metadata: authMetadata,
    clientMetadata: {
      client_name: CLIENT_NAME,
      redirect_uris: [input.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_basic",
      ...(input.scope ? { scope: input.scope } : {}),
    },
    ...(input.scope ? { scope: input.scope } : {}),
    fetchFn,
  }).catch((cause: unknown) => {
    throw new McpOAuthError(
      `${authServerUrl} rejected dynamic client registration: ${errorText(cause)}`,
    );
  });

  // 4. Authorization-code + PKCE URL. The resource indicator (RFC 8707) binds
  //    the eventual token to this MCP server.
  const resource = resourceUrlFromServerUrl(prm.resource ?? input.mcpUrl);
  const { authorizationUrl, codeVerifier } = await startAuthorization(authServerUrl, {
    metadata: authMetadata,
    clientInformation: clientInfo,
    redirectUrl: input.redirectUri,
    ...(input.scope ? { scope: input.scope } : {}),
    ...(resource ? { resource } : {}),
  });

  // 5. Encrypt everything the callback needs into the state param.
  const egressOrigins = [
    ...new Set([input.mcpUrl, tokenEndpoint].map((url) => new URL(url).origin)),
  ];
  const state: MCPOAuthState = {
    v: "mcp-oauth-1",
    projectId: input.projectId,
    path: input.path,
    ...(input.notify ? { notify: input.notify } : {}),
    mcpUrl: input.mcpUrl,
    ...(resource ? { resource: resource.toString() } : {}),
    redirectUri: input.redirectUri,
    authServerUrl,
    tokenEndpoint,
    authMetadata,
    clientId: clientInfo.client_id,
    ...(clientInfo.client_secret ? { clientSecret: clientInfo.client_secret } : {}),
    codeVerifier,
    egressOrigins,
    expiresAt: Date.now() + STATE_TTL_MS,
  };
  authorizationUrl.searchParams.set("state", await encodeState(state, input.encryptionKey));

  return {
    authorizationUrl: authorizationUrl.toString(),
    path: input.path,
    authorizationServer: authServerUrl,
  };
}

export async function completeMcpOAuth(
  input: CompleteMcpOAuthInput,
): Promise<CompleteMcpOAuthResult> {
  const state = await decodeState(input.state, input.encryptionKey);
  if (state.expiresAt < Date.now()) {
    throw new McpOAuthError("this authorization link has expired — ask the agent for a fresh one.");
  }

  const tokens = await exchangeAuthorization(state.authServerUrl, {
    metadata: state.authMetadata as AuthorizationServerMetadata,
    clientInformation: {
      client_id: state.clientId,
      ...(state.clientSecret ? { client_secret: state.clientSecret } : {}),
    },
    authorizationCode: input.code,
    codeVerifier: state.codeVerifier,
    redirectUri: state.redirectUri,
    ...(state.resource ? { resource: new URL(state.resource) } : {}),
    ...(input.iss ? { iss: input.iss } : {}),
    fetchFn: input.fetchFn,
  }).catch((cause: unknown) => {
    throw new McpOAuthError(`token exchange failed: ${errorText(cause)}`);
  });

  // A confidential client (has a secret) gets the shared oauth-refresh-token
  // strategy, reading its own clientId/clientSecret out of material so the
  // Secret DO re-mints on 401 in trusted code. A public client (no secret) has
  // no Basic-auth refresh path here, so we store the tokens without a strategy —
  // the access token works until it expires, and reconnecting re-runs the flow.
  const material: Record<string, string> = {
    accessToken: tokens.access_token,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    ...(state.clientSecret ? { clientId: state.clientId, clientSecret: state.clientSecret } : {}),
  };
  const refresh: SecretRefresh | undefined =
    state.clientSecret && tokens.refresh_token
      ? { kind: "oauth-refresh-token", tokenEndpoint: state.tokenEndpoint, clientCreds: "material" }
      : undefined;

  return {
    path: state.path,
    ...(state.notify ? { notify: state.notify } : {}),
    mcpUrl: state.mcpUrl,
    egressOrigins: state.egressOrigins,
    secret: {
      material,
      egress: { urls: state.egressOrigins },
      ...(refresh ? { refresh } : {}),
    },
  };
}

/** Decrypt just the projectId out of a state token so the callback can address
 * the right project's egress + Secret DO before the full completeMcpOAuth. The
 * whole state is re-validated there; this is the routing read (the encrypted
 * analogue of parseOAuthStateUnverified). Throws McpOAuthError on a bad token. */
export async function readMcpOAuthProjectId(state: string, encryptionKey: string): Promise<string> {
  return (await decodeState(state, encryptionKey)).projectId;
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

async function encodeState(state: MCPOAuthState, key: string): Promise<string> {
  const encrypted = await encryptSecretMaterial(JSON.stringify(state), key);
  return toBase64Url(JSON.stringify(encrypted));
}

async function decodeState(token: string, key: string): Promise<MCPOAuthState> {
  let json: string;
  try {
    const encrypted = JSON.parse(fromBase64Url(token));
    json = await decryptSecretMaterial(encrypted, key);
  } catch {
    throw new McpOAuthError(
      "this authorization link is malformed or was signed for another deployment.",
    );
  }
  return MCPOAuthState.parse(JSON.parse(json));
}

/** Adapt a Cloudflare Fetcher (project egress) to the SDK's FetchLike. Unlike
 * the MCP client's stateless adapter, this forwards GETs unchanged — OAuth
 * discovery reads the server's well-known metadata over GET. */
export function fetchLikeFromFetcher(fetcher: Fetcher): FetchLike {
  return (url, init) => fetcher.fetch(new Request(url as string | URL, init as RequestInit));
}

/** The default secret path for a server's token when the caller gives none:
 * `/secrets/mcp/<host>` (host lowercased, non-path-safe chars collapsed). */
export function defaultMcpSecretPath(mcpUrl: string): string {
  const host = new URL(mcpUrl).host.toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
  return `/secrets/mcp/${host}`;
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
