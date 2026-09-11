import { WorkerEntrypoint } from "cloudflare:workers";

//#region src/ema/result.d.ts

/**
 * Tagged union of every validation failure that can occur on the EMA token
 * endpoint path. Extend by adding a new arm; the exhaustive `switch` in
 * `emaErrorToWire` will surface unhandled cases at compile time.
 */
type EmaValidationError = {
  reason: 'assertion_missing';
} | {
  reason: 'assertion_too_large';
  size: number;
  max: number;
} | {
  reason: 'assertion_malformed';
} | {
  reason: 'invalid_typ';
  got?: unknown;
} | {
  reason: 'invalid_alg';
  got?: unknown;
} | {
  reason: 'issuer_not_trusted';
  iss: string;
} | {
  reason: 'no_matching_key';
  kid?: string;
} | {
  reason: 'signature_failed';
} | {
  reason: 'jwks_fetch_failed';
  status?: number;
} | {
  reason: 'invalid_claim';
  claim: string;
} | {
  reason: 'aud_mismatch';
  expected: string;
  got: string | string[];
} | {
  reason: 'unsupported_claim';
  claim: 'authorization_details' | 'cnf';
} | {
  reason: 'expired';
  exp: number;
  now: number;
} | {
  reason: 'iat_in_future';
  iat: number;
  now: number;
  skew: number;
} | {
  reason: 'nbf_in_future';
  nbf: number;
  now: number;
  skew: number;
} | {
  reason: 'lifetime_too_long';
  lifetime: number;
  max: number;
} | {
  reason: 'replayed';
  jti: string;
} | {
  reason: 'client_id_mismatch';
  expected: string;
  got: string;
} | {
  reason: 'resource_invalid';
  resource: string;
} | {
  reason: 'resource_mismatch';
  expected: string;
  got: string;
} | {
  reason: 'invalid_scope_param';
} | {
  reason: 'invalid_mapped_user';
} | {
  reason: 'invalid_mapped_scope';
} | {
  reason: 'invalid_mapped_props';
} | {
  reason: 'invalid_mapped_ttl';
} | {
  reason: 'mapper_denied';
} | {
  reason: 'mapper_threw';
} | {
  reason: 'assertion_expired_after_processing';
};
//#endregion
//#region src/ema/types.d.ts
/**
 * Claims expected in an MCP Enterprise-Managed Authorization ID-JAG assertion.
 * Additional issuer-specific claims (e.g. `email`) are preserved verbatim
 * under the index signature.
 */
interface EmaIdJagClaims {
  /** Identity provider issuer URL. */
  iss: string;
  /** Enterprise subject identifier for the resource owner. */
  sub: string;
  /** Authorization server issuer URL or URLs for which this assertion is intended. */
  aud: string | string[];
  /**
   * Effective RFC 9728 resource identifier of the MCP server. When the ID-JAG
   * omits its optional `resource` claim, the provider supplies its configured
   * `resourceMetadata.resource` value.
   */
  resource: string;
  /** OAuth client identifier this assertion was issued to. */
  client_id: string;
  /** Unique assertion identifier used for replay protection. */
  jti: string;
  /** Assertion expiration time as a Unix timestamp in seconds. */
  exp: number;
  /** Assertion issued-at time as a Unix timestamp in seconds. */
  iat: number;
  /** Optional space-separated OAuth scope string. */
  scope?: string;
  /** Optional email claim supplied by the enterprise IdP. */
  email?: string;
  /** Additional enterprise IdP claims. */
  [claim: string]: unknown;
}
/**
 * Trusted enterprise IdP configuration for ID-JAG validation.
 */
interface EmaTrustedIssuer {
  /** Issuer URL that must exactly match the assertion `iss` claim. */
  issuer: string;
  /** HTTPS JWKS endpoint used to validate assertion signatures. */
  jwksUri: string;
  /** Allowed JWT signing algorithms for this issuer. Defaults to `['RS256']`. */
  algorithms?: string[];
  /** Expected authorization server audience. Defaults to this provider's issuer URL. */
  audience?: string;
}
/**
 * Input passed to `enterpriseManagedAuthorization.mapClaims` after ID-JAG validation.
 */
interface EmaClaimsMapperInput<Env = Cloudflare.Env> {
  /** Validated ID-JAG claims. */
  claims: EmaIdJagClaims;
  /** Authenticated OAuth client that presented the assertion. */
  clientInfo: ClientInfo;
  /**
   * Effective MCP resource identifier. Taken from the assertion when present,
   * otherwise from the provider's configured `resourceMetadata.resource`.
   */
  resource: string;
  /** Requested scopes after downscoping to the assertion's scope claim, if present. */
  requestedScope: string[];
  /** The original HTTP token request, e.g. for inspecting Host header in multi-tenant routing. */
  request: Request;
  /** Cloudflare Worker environment variables. */
  env: Env;
}
/**
 * Result returned by `enterpriseManagedAuthorization.mapClaims`.
 */
interface EmaClaimsMapperResult {
  /**
   * User ID to associate with the issued grant and access token.
   *
   * Must not contain `:` — the opaque access token format issued by this
   * provider uses `:` as an internal separator, so a `userId` containing
   * it will produce tokens that fail to parse on validation. If the IdP
   * subject may contain `:` (e.g. an email), encode or hash it first
   * (e.g. ``userId: `enterprise-${encodeURIComponent(claims.sub)}` ``).
   */
  userId: string;
  /** Scopes to grant to the issued access token. */
  scope: string[];
  /**
   * Optional grant metadata used for audit and grant listing. This is not
   * encrypted. Stored on the grant in KV alongside the user ID — visible to
   * server-side code via `OAuthHelpers` but never exposed to the MCP client.
   * Use for audit logs, admin UIs, or "list active sessions" features.
   */
  metadata?: unknown;
  /**
   * Application props encrypted into the issued access token and exposed to
   * API handlers on every authenticated request (via `getMcpAuthContext()`
   * for MCP servers, or `ctx.props` in the underlying OAuth helpers). Use
   * for per-request data the protected resource needs without hitting the
   * IdP again — e.g. `enterprise: true`, subject, email, role claims.
   */
  props: unknown;
  /**
   * Optional access token TTL override in seconds. Overrides the AS's
   * configured default. Not clamped to the assertion lifetime — the ID-JAG
   * `exp` governs how long the assertion remains a usable grant, not the
   * lifetime of the access token it mints (RFC 7523 §3).
   */
  accessTokenTTL?: number;
}
/**
 * Maps validated enterprise ID-JAG claims to this provider's local user, scopes,
 * metadata, and props. Return `null` to deny token issuance.
 *
 * Always async — mirrors `EmaTrustedIssuerResolver` so the two enterprise
 * callbacks have the same shape and downstream lookups (KV, D1, IdP federation)
 * don't require a later API change to add `Promise<…>` return support.
 */
type EmaClaimsMapper<Env = Cloudflare.Env> = (input: EmaClaimsMapperInput<Env>) => Promise<EmaClaimsMapperResult | null>;
/**
 * Input passed to a dynamic `EmaTrustedIssuerResolver`.
 *
 * The `iss` value comes from the assertion's unverified payload — it is
 * used here only as a routing key to choose which IdP's JWKS to load.
 * The cryptographic trust comes from signature verification later, so
 * the resolver may safely treat `iss` as untrusted input.
 */
interface EmaTrustedIssuerResolverInput<Env = Cloudflare.Env> {
  /** Issuer URL from the assertion's `iss` claim (unverified). */
  iss: string;
  /** Cloudflare Worker environment variables (bindings, secrets, KV, D1). */
  env: Env;
  /** The original HTTP request, e.g. for inspecting the Host header in multi-tenant routing. */
  request: Request;
  /** Authenticated OAuth client that presented the assertion. */
  clientInfo: ClientInfo;
}
/**
 * Dynamic resolver for `EmaOptions.trustedIssuers`.
 *
 * Returns the trusted issuer configuration for an incoming `iss` claim,
 * or `null` if the issuer is not trusted for this client / tenant. The
 * returned `issuer` field must equal the input `iss` — the AS enforces
 * this to prevent a resolver from being tricked into returning a config
 * for a different IdP than the one the assertion claims to be from.
 *
 * Useful for B2B platforms where new tenants onboard their own IdPs
 * dynamically and the AS cannot ship a static list at deploy time.
 *
 * **SSRF warning**: `jwksUri` is fetched outbound by the AS. If your
 * resolver reads `jwksUri` from tenant-controlled storage (self-service
 * tenant onboarding, etc.), an attacker who controls a tenant config
 * can point the AS at arbitrary HTTPS endpoints — internal services,
 * cloud metadata endpoints, victim hosts for DoS amplification. The
 * library only enforces `https:`; deployers must validate `jwksUri`
 * against their own allowlist (e.g. registered IdP vendor domains)
 * before storing or returning it.
 */
type EmaTrustedIssuerResolver<Env = Cloudflare.Env> = (input: EmaTrustedIssuerResolverInput<Env>) => Promise<EmaTrustedIssuer | null>;
/**
 * MCP Enterprise-Managed Authorization configuration.
 *
 * Presence of this option on `OAuthProviderOptions` enables the EMA grant.
 * There is intentionally no `enabled` flag — forgetting to set it would
 * silently disable the feature despite full configuration.
 */
interface EmaOptions<Env = Cloudflare.Env> {
  /**
   * Resolver that returns the trusted issuer configuration for an
   * incoming `iss` claim, or `null` to reject the assertion.
   *
   * Always a function — for a fixed list of IdPs, write a one-line closure:
   *
   * ```ts
   * const issuers = [{ issuer: 'https://idp.example.com', jwksUri: '...' }];
   * trustedIssuers: async ({ iss }) => issuers.find((i) => i.issuer === iss) ?? null,
   * ```
   *
   * For B2B / multi-tenant deployments, the resolver can consult `env`,
   * `request`, or `clientInfo` to look up the issuer dynamically (e.g.
   * a per-tenant config in KV / D1) without redeploying.
   */
  trustedIssuers: EmaTrustedIssuerResolver<Env>;
  /** Maps validated enterprise claims to local token data. */
  mapClaims: EmaClaimsMapper<Env>;
  /** JWKS cache TTL in seconds. Defaults to 300 seconds. */
  jwksCacheTtlSeconds?: number;
  /** Allowed clock skew for `exp` and `iat` checks in seconds. Defaults to 60 seconds. */
  clockSkewSeconds?: number;
  /** Maximum accepted assertion lifetime in seconds. Defaults to 300 seconds. */
  maxAssertionLifetimeSeconds?: number;
  /**
   * Allow public clients (`token_endpoint_auth_method: 'none'`) to use the
   * enterprise-managed authorization (ID-JAG) grant.
   *
   * Defaults to `false`. By default the EMA grant requires client
   * authentication, matching the MCP enterprise-managed-authorization draft.
   *
   * Set to `true` to also accept public clients on this grant — for example
   * clients registered via a Client ID Metadata Document (CIMD), which are
   * always public (`none`) and therefore cannot present a client secret. The
   * security trade-off is documented in the README: the trust then rests on
   * the IdP-issued, signature-verified, short-lived, single-use ID-JAG
   * assertion (audience- and client-bound), together with the provider's
   * configured resource pinning, rather than on a separately presented client
   * secret.
   */
  allowPublicClients?: boolean;
}
//#endregion
//#region src/oauth-capabilities.d.ts
type AuthorizationErrorCode = 'invalid_request' | 'invalid_target' | 'unauthorized_client' | 'access_denied' | 'unsupported_response_type' | 'invalid_scope' | 'server_error' | 'temporarily_unavailable';
interface AuthorizationErrorOptions {
  /** Wire-safe OAuth authorization error description. */
  description: string;
  /** Exact registered redirect URI. Present only after client and redirect validation. */
  redirectUri?: string;
  /** Original client state, when supplied. */
  state?: string;
  /** Authorization server issuer for RFC 9207 error responses. */
  issuer?: string;
}
/**
 * Expected authorization-request validation failure. Absence of `redirectUri`
 * means a caller MUST render locally and MUST NOT redirect.
 */
declare class AuthorizationError extends Error {
  readonly code: AuthorizationErrorCode;
  readonly description: string;
  readonly redirectUri?: string;
  readonly state?: string;
  readonly issuer?: string;
  constructor(code: AuthorizationErrorCode, options: AuthorizationErrorOptions);
}
declare function isValidOAuthScopeToken(scopeToken: string): boolean;
//#endregion
//#region src/oauth-provider.d.ts
/**
 * Enum representing OAuth grant types
 */
declare enum GrantType {
  AUTHORIZATION_CODE = "authorization_code",
  REFRESH_TOKEN = "refresh_token",
  TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange",
  JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer",
}
/**
 * Aliases for either type of Handler that makes .fetch required
 */
type ExportedHandlerWithFetch<Env = Cloudflare.Env> = ExportedHandler<Env> & Pick<Required<ExportedHandler<Env>>, 'fetch'>;
type WorkerEntrypointWithFetch<Env = Cloudflare.Env> = WorkerEntrypoint<Env> & {
  fetch: NonNullable<WorkerEntrypoint['fetch']>;
};
/**
 * Configuration options for the OAuth Provider
 */
/**
 * Registered OAuth 2.0 error codes that the `/token` endpoint may return.
 *
 * Union of:
 *   - RFC 6749 §5.2 (token endpoint)
 *   - RFC 6750 §3.1 (bearer / resource server) — included so callbacks
 *     doing audience validation can use them
 *   - RFC 8693 §2.2.2 (token exchange)
 */
type OAuthTokenErrorCode = 'invalid_request' | 'invalid_client' | 'invalid_grant' | 'unauthorized_client' | 'unsupported_grant_type' | 'invalid_scope' | 'invalid_token' | 'insufficient_scope' | 'invalid_target' | 'server_error' | 'temporarily_unavailable';
/**
 * Result of a token exchange callback function.
 * Allows updating the props stored in both the access token and the grant.
 */
interface TokenExchangeCallbackResult {
  /**
   * New props to be stored specifically with the access token.
   * If not provided but newProps is, the access token will use newProps.
   * If neither is provided, the original props will be used.
   */
  accessTokenProps?: any;
  /**
   * New props to replace the props stored in the grant itself.
   * These props will be used for all future token refreshes.
   * If accessTokenProps is not provided, these props will also be used for the current access token.
   * If not provided, the original props will be used.
   */
  newProps?: any;
  /**
   * Override the default access token TTL (time-to-live) for this specific token.
   * This is especially useful when the application is also an OAuth client to another service
   * and wants to match its access token TTL to the upstream access token TTL.
   * Value should be in seconds.
   */
  accessTokenTTL?: number;
  /**
   * Override the default refresh token TTL (time-to-live) for this specific grant.
   * Value should be in seconds.
   * Note: This is only honored during authorization code exchange. If returned during
   * refresh token exchange, it will be ignored.
   */
  refreshTokenTTL?: number;
  /**
   * Optional scopes for the new access token. Values outside the scope ceiling
   * for the current grant flow are ignored. If omitted, the effective requested
   * scopes are used.
   */
  accessTokenScope?: string[];
}
/**
 * Options for token exchange callback functions
 */
interface TokenExchangeCallbackOptions {
  /**
   * The type of grant being processed.
   */
  grantType: GrantType;
  /**
   * Client that received this grant
   */
  clientId: string;
  /**
   * User who authorized this grant
   */
  userId: string;
  /**
   * Identifier of the grant record this callback is operating on. Stable across
   * refreshes for the lifetime of the grant. Pass this together with `userId`
   * to {@link OAuthHelpers.revokeGrant} when the callback decides the grant
   * should be torn down (for example, after an upstream refresh fails with a
   * terminal error code).
   */
  grantId: string;
  /**
   * List of scopes on the underlying authorization grant.
   */
  scope: string[];
  /**
   * Effective scopes selected for this token before applying the callback result.
   */
  requestedScope: string[];
  /**
   * Application-specific properties currently associated with this grant
   */
  props: any;
}
/**
 * Options for the client registration callback (RFC 7591).
 */
interface ClientRegistrationCallbackOptions {
  /**
   * Parsed client metadata from the registration request body.
   *
   * Note: This is the raw JSON body. RFC 7591 §3.1.1 `software_statement` claims
   * are NOT currently merged in by the library — if `software_statement` is present
   * the callback is responsible for verifying the JWT and applying its claims.
   */
  clientMetadata: Record<string, unknown>;
  /**
   * A clone of the registration HTTP request. The body has not been consumed,
   * so the callback may call `request.text()` / `request.json()` if needed
   * (e.g. to validate a signature over the raw body).
   */
  request: Request;
}
/**
 * Result of the client registration callback.
 *
 * Return `undefined`/nothing to allow registration. Return an object to reject
 * registration. By default, rejection follows RFC 7591 §3.2.2:
 * `invalid_client_metadata` with HTTP 400.
 */
interface ClientRegistrationCallbackResult {
  /**
   * OAuth error code when rejecting. Defaults to `invalid_client_metadata`.
   * For non-metadata rejections (e.g. missing initial access token, untrusted
   * origin), set this to a more specific code such as `access_denied` or
   * `invalid_token`.
   */
  code?: string;
  /** Error description when rejecting. */
  description?: string;
  /**
   * HTTP status code when rejecting. Defaults to 400. Override for auth-style
   * failures (e.g. 401 for missing IAT, 403 for policy denial).
   */
  status?: number;
}
/**
 * Input parameters for the resolveExternalToken callback function
 */
interface ResolveExternalTokenInput<Env = Cloudflare.Env> {
  /**
   * The token string that was provided in the Authorization header
   */
  token: string;
  /**
   * The original HTTP request
   */
  request: Request;
  /**
   * Cloudflare Worker environment variables
   */
  env: Env;
}
/**
 * Result returned from the resolveExternalToken callback function
 */
interface ResolveExternalTokenResult {
  /**
   * Application-specific properties that will be passed to the API handlers.
   * These properties are set in the execution context (`ctx.props`) after the
   * external bearer credential is validated.
   */
  props: any;
  /**
   * Protected resource audience established by the external validator.
   *
   * A JWT may carry this value as an `aud` claim. For an opaque API token or
   * PAT, the callback can supply the local resource URI as policy after
   * successful validation. When `resourceMetadata.resource` is configured,
   * this value is required and must match it exactly.
   */
  audience?: string | string[];
}
interface OAuthProviderOptions<Env = Cloudflare.Env> {
  /**
   * URL(s) for API routes. Requests with URLs starting with any of these prefixes
   * will be treated as API requests and require a valid access token.
   * Can be a single route or an array of routes. Each route can be a full URL or just a path.
   *
   * Used with `apiHandler` for the single-handler configuration. This is incompatible with
   * the `apiHandlers` property. You must use either `apiRoute` + `apiHandler` OR `apiHandlers`, not both.
   */
  apiRoute?: string | string[];
  /**
   * Handler for API requests that have a valid access token.
   * This handler will receive the authenticated user properties in ctx.props.
   * Can be either an ExportedHandler object with a fetch method or a class extending WorkerEntrypoint.
   *
   * Used with `apiRoute` for the single-handler configuration. This is incompatible with
   * the `apiHandlers` property. You must use either `apiRoute` + `apiHandler` OR `apiHandlers`, not both.
   */
  apiHandler?: ExportedHandlerWithFetch<Env> | (new (ctx: ExecutionContext, env: Env) => WorkerEntrypointWithFetch<Env>);
  /**
   * Map of API routes to their corresponding handlers for the multi-handler configuration.
   * The keys are the API routes (strings only, not arrays), and the values are the handlers.
   * Each route can be a full URL or just a path, and each handler can be either an ExportedHandler
   * object with a fetch method or a class extending WorkerEntrypoint.
   *
   * This is incompatible with the `apiRoute` and `apiHandler` properties. You must use either
   * `apiRoute` + `apiHandler` (single-handler configuration) OR `apiHandlers` (multi-handler
   * configuration), not both.
   */
  apiHandlers?: Record<string, ExportedHandlerWithFetch<Env> | (new (ctx: ExecutionContext, env: Env) => WorkerEntrypointWithFetch<Env>)>;
  /**
   * Handler for all non-API requests or API requests without a valid token.
   * Can be either an ExportedHandler object with a fetch method or a class extending WorkerEntrypoint.
   */
  defaultHandler: ExportedHandler<Env> | (new (ctx: ExecutionContext, env: Env) => WorkerEntrypointWithFetch<Env>);
  /**
   * URL of the OAuth authorization endpoint where users can grant permissions.
   * This URL is used in OAuth metadata and is not handled by the provider itself.
   */
  authorizeEndpoint: string;
  /**
   * URL of the token endpoint which the provider will implement.
   * This endpoint handles token issuance, refresh, and revocation.
   */
  tokenEndpoint: string;
  /**
   * Optional URL for the client registration endpoint.
   * If provided, the provider will implement dynamic client registration.
   */
  clientRegistrationEndpoint?: string;
  /**
   * Time-to-live for access tokens in seconds.
   * Defaults to 1 hour (3600 seconds) if not specified.
   */
  accessTokenTTL?: number;
  /**
   * Time-to-live for refresh tokens in seconds.
   * Defaults to 30 days (2,592,000 seconds).
   * Set to 0 to disable refresh tokens entirely.
   * Set to `undefined` explicitly for refresh tokens that never expire.
   * For example: 3600 = 1 hour, 2592000 = 30 days
   */
  refreshTokenTTL?: number;
  /**
   * Time-to-live for dynamically registered clients in seconds.
   * Defaults to 90 days (7,776,000 seconds).
   * Clients created via the DCR endpoint will automatically expire after this duration.
   * Clients created via `OAuthHelpers.createClient()` are not affected by this setting.
   * Set to `undefined` explicitly for clients that never expire.
   */
  clientRegistrationTTL?: number;
  /**
   * Scopes supported by the authorization server.
   * These are advertised only in authorization server metadata; configure
   * `resourceMetadata.scopes_supported` separately for protected resource requirements.
   */
  scopesSupported?: string[];
  /**
   * Controls whether the OAuth implicit flow is allowed.
   * This flow is discouraged in OAuth 2.1 due to security concerns.
   * Defaults to false.
   */
  allowImplicitFlow?: boolean;
  /**
   * Controls whether the legacy plain PKCE method is allowed.
   * Defaults to false so PKCE challenges use S256 exclusively.
   * Set to true only for compatibility with clients that cannot use S256.
   */
  allowPlainPKCE?: boolean;
  /**
   * Controls whether OAuth 2.0 Token Exchange (RFC 8693) is allowed.
   * When false, the token exchange grant type will not be advertised in metadata
   * and token exchange requests will be rejected.
   * Defaults to false.
   */
  allowTokenExchangeGrant?: boolean;
  /**
   * Experimental support for the MCP Enterprise-Managed Authorization extension.
   * When enabled, the token endpoint accepts ID-JAG assertions using the JWT bearer
   * grant type (`urn:ietf:params:oauth:grant-type:jwt-bearer`).
   *
   * This feature is opt-in because the MCP extension and underlying OAuth drafts are
   * still evolving. Trusted issuers and a claim mapper are required.
   */
  enterpriseManagedAuthorization?: EmaOptions<Env>;
  /**
   * Controls whether public clients (clients without a secret, like SPAs) can register via the
   * dynamic client registration endpoint. When true, only confidential clients can register.
   * Note: Creating public clients via the OAuthHelpers.createClient() method is always allowed.
   * Defaults to false.
   */
  disallowPublicClientRegistration?: boolean;
  /**
   * Called during DCR (RFC 7591) before the client is stored. Return void/undefined
   * to allow registration, or return an object to reject it.
   */
  clientRegistrationCallback?: (options: ClientRegistrationCallbackOptions) => Promise<ClientRegistrationCallbackResult | void> | ClientRegistrationCallbackResult | void;
  /**
   * Optional callback function that is called during token exchange.
   * This allows updating the props stored in both the access token and the grant.
   * For example, if the application itself is also a client to some other OAuth API,
   * it may want to perform the equivalent upstream token exchange, and store the result in the props.
   *
   * The callback can return new props values that will be stored with the token or grant.
   * If the callback returns nothing or undefined for a props field, the original props will be used.
   */
  tokenExchangeCallback?: (options: TokenExchangeCallbackOptions) => Promise<TokenExchangeCallbackResult | void> | TokenExchangeCallbackResult | void;
  /**
   * Optional callback called when a provided bearer credential was not found
   * in the internal KV. It can validate an external OAuth access token, opaque
   * API token, personal access token (PAT), or another bearer credential and
   * set the application props passed to the protected handler.
   *
   * Return props to authenticate the request, or `null` for a generic `invalid_token` response.
   * Throw this package's exported {@link ExternalTokenError} to return an intentional
   * structured error response for an upstream validation failure.
   * All other thrown errors, including {@link OAuthError}, remain unexpected
   * failures and are re-thrown for backwards compatibility.
   */
  resolveExternalToken?: (input: ResolveExternalTokenInput<Env>) => Promise<ResolveExternalTokenResult | null>;
  /**
   * Optional callback function that is called whenever the OAuthProvider returns an error response.
   * This allows the client to emit notifications or perform other actions when an error occurs.
   *
   * If the function returns a Response, that will be used in place of the OAuthProvider's default one.
   *
   * `internal` (when present) carries a tagged, server-side-only reason that the library
   * deliberately did NOT put on the wire — used for richer diagnostics where the public
   * response must stay generic (e.g. JWT validation failures on the EMA path). Backwards
   * compatible: existing callbacks ignoring this field continue to work unchanged.
   *
   * `request` (when present) is the HTTP request that produced the error response, so the
   * callback can correlate the error with per-request state such as request-keyed telemetry.
   * Currently populated for CIMD metadata fetch failures at the token endpoint. Backwards
   * compatible in the same way as `internal`.
   */
  onError?: (error: {
    code: string;
    description: string;
    status: number;
    headers: Record<string, string>;
    internal?: {
      category: string;
      reason: string;
      detail?: unknown;
    };
    request?: Request;
  }) => Response | void;
  /**
   * Explicitly enable Client ID Metadata Document (CIMD) support.
   * When true, URL-formatted client_ids will be fetched as metadata documents.
   * Requires the 'global_fetch_strictly_public' compatibility flag.
   * Defaults to false.
   */
  clientIdMetadataDocumentEnabled?: boolean;
  /**
   * When true, requested-vs-granted resource validation compares origins only
   * (scheme + host + port) instead of exact URIs. This allows an origin-only
   * grant such as `https://server.com` to accept `https://server.com/mcp`, but
   * also ignores path and query differences. Configured canonical resources
   * always use exact matching.
   *
   * Defaults to false (strict exact matching per RFC 8707).
   *
   * @deprecated This comparison is unsafe for shared-origin multi-path or
   * multi-tenant deployments. Prefer configuring `resourceMetadata.resource`.
   */
  resourceMatchOriginOnly?: boolean;
  /**
   * Optional metadata for RFC 9728 OAuth 2.0 Protected Resource Metadata.
   * Controls the response served at /.well-known/oauth-protected-resource.
   *
   * If not provided, the endpoint will be automatically generated using the request origin
   * as the resource identifier, and the token endpoint's origin as the authorization server.
   */
  resourceMetadata?: {
    /**
     * The protected resource identifier URL (RFC 9728 `resource` field).
     *
     * Configuring this value pins grants and access-token audiences to this
     * exact resource. An omitted authorization resource defaults to this value,
     * and an omitted token-request resource inherits it from the grant. Without
     * configuration, explicit RFC 8707 resource indicators are accepted and
     * omission remains unbound for backwards compatibility.
     */
    resource?: string;
    /**
     * List of authorization server issuer URLs that can issue tokens for this resource.
     * If not set, defaults to the token endpoint's origin (consistent with the issuer
     * in authorization server metadata).
     */
    authorization_servers?: string[];
    /**
     * Minimal scopes required for basic protected resource functionality.
     * These scopes are advertised in Protected Resource Metadata and used as
     * baseline bearer challenge guidance. `offline_access` is omitted because
     * refresh-token issuance is an authorization server capability.
     */
    scopes_supported?: string[];
    /**
     * Methods by which bearer tokens can be presented to this resource.
     * Defaults to ["header"].
     */
    bearer_methods_supported?: string[];
    /**
     * Human-readable name for this resource.
     */
    resource_name?: string;
  };
}
/**
 * Helper methods for OAuth operations provided to handler functions
 */
interface OAuthHelpers {
  /**
   * Parses an OAuth authorization request from the HTTP request
   * @param request - The HTTP request containing OAuth parameters
   * @returns The parsed authorization request parameters
   * @throws Error when the response type is missing, unsupported, or not registered for the client
   * @throws {@link CimdFetchError} when the client ID is a CIMD URL whose document cannot be resolved
   */
  parseAuthRequest(request: Request): Promise<AuthRequest>;
  /**
   * Looks up a client by its client ID
   * @param clientId - The client ID to look up
   * @returns A Promise resolving to the client info, or null if the client does not exist
   * @throws {@link CimdFetchError} when the client ID is a CIMD URL whose document cannot be resolved
   */
  lookupClient(clientId: string): Promise<ClientInfo | null>;
  /**
   * Completes an authorization request by creating a grant and authorization code
   * @param options - Options specifying the grant details
   * @returns A Promise resolving to an object containing the redirect URL
   * @throws Error when the request's response type is not permitted
   * @throws {@link CimdFetchError} when the client ID is a CIMD URL whose document cannot be resolved
   */
  completeAuthorization(options: CompleteAuthorizationOptions): Promise<{
    redirectTo: string;
  }>;
  /**
   * Creates a new OAuth client
   * @param clientInfo - Partial client information to create the client with
   * @returns A Promise resolving to the created client info
   */
  createClient(clientInfo: Partial<ClientInfo>): Promise<ClientInfo>;
  /**
   * Lists all registered OAuth clients with pagination support
   * @param options - Optional pagination parameters (limit and cursor)
   * @returns A Promise resolving to the list result with items and optional cursor
   */
  listClients(options?: ListOptions): Promise<ListResult<ClientInfo>>;
  /**
   * Updates an existing OAuth client
   * @param clientId - The ID of the client to update
   * @param updates - Partial client information with fields to update
   * @returns A Promise resolving to the updated client info, or null if not found
   */
  updateClient(clientId: string, updates: Partial<ClientInfo>): Promise<ClientInfo | null>;
  /**
   * Deletes an OAuth client
   * @param clientId - The ID of the client to delete
   * @returns A Promise resolving when the deletion is confirmed.
   */
  deleteClient(clientId: string): Promise<void>;
  /**
   * Lists all authorization grants for a specific user with pagination support
   * Returns a summary of each grant without sensitive information
   * @param userId - The ID of the user whose grants to list
   * @param options - Optional pagination parameters (limit and cursor)
   * @returns A Promise resolving to the list result with grant summaries and optional cursor
   */
  listUserGrants(userId: string, options?: ListOptions): Promise<ListResult<GrantSummary>>;
  /**
   * Revokes an authorization grant
   * @param grantId - The ID of the grant to revoke
   * @param userId - The ID of the user who owns the grant
   * @returns A Promise resolving when the revocation is confirmed.
   */
  revokeGrant(grantId: string, userId: string): Promise<void>;
  /**
   * Decodes a token and returns token data with decrypted props
   * @param token - The token
   * @returns Promise resolving to token data with decrypted props, or null if token is invalid
   */
  unwrapToken<T = any>(token: string): Promise<TokenSummary<T> | null>;
  /**
   * Exchanges an existing access token for a new one with modified characteristics
   * Implements OAuth 2.0 Token Exchange (RFC 8693)
   * @param options - Options for token exchange including subject token and optional modifications
   * @returns Promise resolving to token response with new access token
   * @throws {@link CimdFetchError} when the grant's client ID is a CIMD URL whose document cannot be resolved
   */
  exchangeToken(options: ExchangeTokenOptions): Promise<TokenResponse>;
  /**
   * Purges expired and orphaned data from the KV namespace.
   * Designed to be called from a scheduled handler (Cron Trigger) for periodic cleanup.
   * Processes records in configurable batches to stay within Cloudflare's subrequest limits.
   *
   * Performs two sweep phases:
   * 1. Grant sweep: removes orphaned grants (client deleted) and expired grants (defense-in-depth for KV TTL)
   * 2. Token sweep: removes orphaned tokens (grant deleted) as defense-in-depth
   *
   * Safe to call repeatedly — deleted records disappear from KV, so subsequent invocations
   * naturally process fresh records without needing a persisted cursor.
   *
   * @param options - Optional configuration for batch size and which purge types to enable
   * @returns Statistics about what was checked and purged, and whether the full scan completed
   */
  purgeExpiredData(options?: PurgeOptions): Promise<PurgeResult>;
}
/**
 * Options for token exchange operations (RFC 8693)
 */
interface ExchangeTokenOptions {
  /**
   * The subject token to exchange (existing access token)
   */
  subjectToken: string;
  /**
   * Optional requested scopes for the new token. Issued scopes are limited to the subject token's scopes.
   */
  scope?: string[];
  /**
   * Optional target audience/resource for the new token (maps to resource parameter per RFC 8707)
   */
  aud?: string | string[];
  /**
   * Optional TTL override for the new token in seconds (must not exceed subject token's remaining lifetime)
   */
  expiresIn?: number;
}
/**
 * Parsed OAuth authorization request parameters
 */
interface AuthRequest {
  /**
   * OAuth response type (e.g., "code" for authorization code flow)
   */
  responseType: string;
  /**
   * Client identifier for the OAuth client
   */
  clientId: string;
  /**
   * URL to redirect to after authorization
   */
  redirectUri: string;
  /**
   * Array of requested permission scopes
   */
  scope: string[];
  /**
   * Client state value to be returned in the redirect
   */
  state: string;
  /**
   * PKCE code challenge (RFC 7636)
   */
  codeChallenge?: string;
  /**
   * PKCE code challenge method (plain or S256)
   */
  codeChallengeMethod?: string;
  /**
   * Resource parameter indicating target resource(s) (RFC 8707)
   */
  resource?: string | string[];
  /**
   * Authorization server issuer recorded while parsing this request.
   * Include it as `iss` in successful and error authorization responses.
   */
  issuer?: string;
}
/**
 * OAuth client registration information
 */
interface ClientInfo {
  /**
   * Unique identifier for the client
   */
  clientId: string;
  /**
   * Secret used to authenticate the client (stored as a hash)
   * Only present for confidential clients; undefined for public clients.
   */
  clientSecret?: string;
  /**
   * List of allowed redirect URIs for the client
   */
  redirectUris: string[];
  /**
   * Human-readable name of the client application
   */
  clientName?: string;
  /**
   * URL to the client's logo
   */
  logoUri?: string;
  /**
   * URL to the client's homepage
   */
  clientUri?: string;
  /**
   * URL to the client's privacy policy
   */
  policyUri?: string;
  /**
   * URL to the client's terms of service
   */
  tosUri?: string;
  /**
   * URL to the client's JSON Web Key Set for validating signatures
   */
  jwksUri?: string;
  /**
   * RFC 7591 §2.2 internationalized variants of the human-readable client
   * metadata fields, keyed by the raw member name including its BCP 47 language
   * tag (e.g. `"client_name#ja"`, `"tos_uri#fr"`).
   *
   * Only the human-readable fields the RFC names are captured here:
   * `client_name`, `client_uri`, `logo_uri`, `tos_uri`, and `policy_uri`.
   * The canonical (un-tagged) values continue to live in their own typed
   * fields above; this map holds only the locale-specific variants so that
   * consumers can perform their own locale selection.
   */
  i18n?: Record<string, string>;
  /**
   * List of email addresses for contacting the client developers
   */
  contacts?: string[];
  /**
   * List of grant types the client supports
   */
  grantTypes?: string[];
  /**
   * List of response types the client supports
   */
  responseTypes?: string[];
  /**
   * Unix timestamp when the client was registered
   */
  registrationDate?: number;
  /**
   * The authentication method used by the client at the token endpoint.
   * Values include:
   * - 'client_secret_basic': Uses HTTP Basic Auth with client ID and secret (default for confidential clients)
   * - 'client_secret_post': Uses POST parameters for client authentication
   * - 'none': Used for public clients that can't securely store secrets (SPAs, mobile apps, etc.)
   *
   * Public clients use 'none', while confidential clients use either 'client_secret_basic' or 'client_secret_post'.
   */
  tokenEndpointAuthMethod: string;
}
/**
 * Options for completing an authorization request
 */
interface CompleteAuthorizationOptions {
  /**
   * The original parsed authorization request
   */
  request: AuthRequest;
  /**
   * Identifier for the user granting the authorization
   */
  userId: string;
  /**
   * Application-specific metadata to associate with this grant
   */
  metadata: any;
  /**
   * List of scopes that were actually granted (may differ from requested scopes)
   */
  scope: string[];
  /**
   * Application-specific properties to include with API requests
   * authorized by this grant
   */
  props: any;
  /**
   * Revokes all existing grants for this user+client combination
   * after storing the new grant. Defaults to true. This prevents stale
   * tokens from causing infinite re-auth loops when props change.
   * Set to false to allow multiple concurrent grants per user+client.
   */
  revokeExistingGrants?: boolean;
  /**
   * Maximum number of grants to fetch per page when revoking existing
   * grants. Only used when revokeExistingGrants is not false.
   * Must be a positive integer. Values above Cloudflare KV's 1000-key page
   * limit are clamped to 1000. Defaults to 50.
   */
  revokeExistingGrantsBatchSize?: number;
}
/**
 * Authorization grant record
 */
interface Grant {
  /**
   * Unique identifier for the grant
   */
  id: string;
  /**
   * Client that received this grant
   */
  clientId: string;
  /**
   * User who authorized this grant
   */
  userId: string;
  /**
   * List of scopes that were granted
   */
  scope: string[];
  /**
   * Application-specific metadata associated with this grant
   */
  metadata: any;
  /**
   * Encrypted application-specific properties
   */
  encryptedProps: string;
  /**
   * Unix timestamp when the grant was created
   */
  createdAt: number;
  /**
   * Unix timestamp when the grant expires (if TTL is configured)
   */
  expiresAt?: number;
  /**
   * The hash of the current refresh token associated with this grant
   */
  refreshTokenId?: string;
  /**
   * Wrapped encryption key for the current refresh token
   */
  refreshTokenWrappedKey?: string;
  /**
   * The hash of the previous refresh token associated with this grant
   * This token is still valid until the new token is first used
   */
  previousRefreshTokenId?: string;
  /**
   * Wrapped encryption key for the previous refresh token
   */
  previousRefreshTokenWrappedKey?: string;
  /**
   * The hash of the authorization code associated with this grant
   * Retained after exchange so that a replay of the same code can be
   * verified before any action is taken on the grant. The code is
   * considered already exchanged once authCodeWrappedKey is removed.
   */
  authCodeId?: string;
  /**
   * Wrapped encryption key for the authorization code
   * Present only until the authorization code is exchanged; its absence
   * (with authCodeId still set) marks the code as already used.
   */
  authCodeWrappedKey?: string;
  /**
   * PKCE code challenge for this authorization
   * Only present during the authorization code exchange process
   */
  codeChallenge?: string;
  /**
   * PKCE code challenge method (plain or S256)
   * Only present during the authorization code exchange process
   */
  codeChallengeMethod?: string;
  /**
   * Resource parameter from authorization request (RFC 8707 Section 2.1)
   * Indicates the protected resource(s) for which access is requested
   */
  resource?: string | string[];
  /**
   * The exact redirect URI used in the authorization request that created this grant
   * Recorded so that default grant revocation can be scoped to a single installation
   * of a CIMD client (whose client_id is shared across all installations). Absent on
   * grants created before this field was introduced.
   */
  redirectUri?: string;
}
/**
 * OAuth 2.0 Token Response
 * The response returned when exchanging authorization codes or refresh tokens
 */
interface TokenResponse {
  access_token: string;
  token_type: 'bearer';
  expires_in: number;
  refresh_token?: string;
  scope: string;
  /**
   * Resource indicator(s) for the issued access token (RFC 8707 Section 2.2)
   * SHOULD be included to indicate the resource server(s) for which the token is valid
   */
  resource?: string | string[];
}
/**
 * Shared fields for Token and TokenSummary
 */
interface TokenBase {
  /**
   * Unique identifier for the token (hash of the actual token)
   */
  id: string;
  /**
   * Identifier of the grant this token is associated with
   */
  grantId: string;
  /**
   * User ID associated with this token
   */
  userId: string;
  /**
   * Unix timestamp when the token was created
   */
  createdAt: number;
  /**
   * Unix timestamp when the token expires
   */
  expiresAt: number;
  /**
   * Intended audience for this token (RFC 7519 Section 4.1.3)
   * Can be a single string or array of strings
   */
  audience?: string | string[];
  /**
   * List of scopes on this token
   */
  scope: string[];
}
/**
 * Token record stored in KV
 * Note: The actual token format is "{userId}:{grantId}:{random-secret}"
 * but we still only store the hash of the full token string.
 * This contains only access tokens; refresh tokens are stored within the grant records.
 */
interface Token extends TokenBase {
  /**
   * The encryption key for props, wrapped with this token
   */
  wrappedEncryptionKey: string;
  /**
   * Denormalized grant information for faster access
   */
  grant: {
    /**
     * Client that received this grant
     */
    clientId: string;
    /**
     * List of scopes that were granted
     */
    scope: string[];
    /**
     * Encrypted application-specific properties
     */
    encryptedProps: string;
  };
}
/**
 * Token record with decrypted properties
 * Derived from Token but with wrappedEncryptionKey removed and encryptedProps replaced with props
 */
interface TokenSummary<T = any> extends TokenBase {
  /**
   * Denormalized grant information for faster access
   */
  grant: {
    /**
     * Client that received this grant
     */
    clientId: string;
    /**
     * List of scopes that were granted
     */
    scope: string[];
    /**
     * Decrypted application-specific properties
     */
    props: T;
  };
}
/**
 * Options for listing operations that support pagination
 */
interface ListOptions {
  /**
   * Maximum number of items to return (max 1000)
   */
  limit?: number;
  /**
   * Cursor for pagination (from a previous listing operation)
   */
  cursor?: string;
}
/**
 * Result of a listing operation with pagination support
 */
interface ListResult<T> {
  /**
   * The list of items
   */
  items: T[];
  /**
   * Cursor to get the next page of results, if there are more results
   */
  cursor?: string;
}
/**
 * Options for the purgeExpiredData garbage collection method
 */
interface PurgeOptions {
  /**
   * Maximum number of KV keys to check per phase (grants and tokens) per invocation.
   * Each phase (grant sweep, token sweep) gets its own budget of this size.
   * Keep this conservative to stay within Cloudflare's 1000 subrequest limit per invocation,
   * since each checked key requires at least one KV read, and orphaned grants trigger
   * additional KV operations via revokeGrant().
   * Defaults to 50.
   */
  batchSize?: number;
  /**
   * Whether to purge orphaned grants whose client no longer exists in KV.
   * Grants for CIMD (Client ID Metadata Document) clients are always skipped
   * since those clients are not stored in KV.
   * Defaults to true.
   */
  purgeOrphanedGrants?: boolean;
  /**
   * Whether to purge expired grants as defense-in-depth for KV TTL.
   * Normally KV auto-deletes expired entries, but this catches any stragglers.
   * Defaults to true.
   */
  purgeExpiredGrants?: boolean;
  /**
   * Whether to purge orphaned tokens whose grant no longer exists.
   * Tokens already auto-expire via KV TTL (default 1 hour), so this is
   * defense-in-depth for partial revokeGrant() failures.
   * Defaults to true.
   */
  purgeOrphanedTokens?: boolean;
}
/**
 * Result of a purgeExpiredData garbage collection invocation
 */
interface PurgeResult {
  /** Number of grant records checked in this invocation */
  grantsChecked: number;
  /** Number of grant records purged (orphaned or expired) */
  grantsPurged: number;
  /** Number of token records checked in this invocation */
  tokensChecked: number;
  /** Number of token records purged (orphaned) */
  tokensPurged: number;
  /** True if the full key space was scanned in this invocation (both grants and tokens) */
  done: boolean;
}
/**
 * Public representation of a grant, with sensitive data removed
 * Used for list operations where the complete grant data isn't needed
 */
interface GrantSummary {
  /**
   * Unique identifier for the grant
   */
  id: string;
  /**
   * Client that received this grant
   */
  clientId: string;
  /**
   * User who authorized this grant
   */
  userId: string;
  /**
   * List of scopes that were granted
   */
  scope: string[];
  /**
   * Application-specific metadata associated with this grant
   */
  metadata: any;
  /**
   * Unix timestamp when the grant was created
   */
  createdAt: number;
  /**
   * Unix timestamp when the grant expires (if TTL is configured)
   */
  expiresAt?: number;
  /**
   * The exact redirect URI used in the authorization request that created this grant
   * Recorded so that default grant revocation can be scoped to a single installation
   * of a CIMD client (whose client_id is shared across all installations). Absent on
   * grants created before this field was introduced.
   */
  redirectUri?: string;
}
/**
 * OAuth 2.0 Provider implementation for Cloudflare Workers
 * Implements authorization code flow with support for refresh tokens
 * and dynamic client registration.
 */
declare class OAuthProvider<Env = Cloudflare.Env> {
  #private;
  /**
   * Creates a new OAuth provider instance
   * @param options - Configuration options for the provider
   */
  constructor(options: OAuthProviderOptions<Env>);
  /**
   * Main fetch handler for the Worker
   * Routes requests to the appropriate handler based on the URL
   * @param request - The HTTP request
   * @param env - Cloudflare Worker environment variables
   * @param ctx - Cloudflare Worker execution context
   * @returns A Promise resolving to an HTTP Response
   */
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
  /**
   * Purges expired and orphaned data from the KV namespace.
   * Can be called directly from a scheduled handler without needing a request context.
   *
   * @param env - Cloudflare Worker environment variables (must include OAUTH_KV binding)
   * @param options - Optional configuration for batch size and which purge types to enable
   * @returns Statistics about what was checked and purged
   */
  purgeExpiredData(env: Env, options?: PurgeOptions): Promise<PurgeResult>;
}
/**
 * Gets OAuthHelpers for the given environment
 * @param options - Configuration options for the OAuth provider
 * @param env - Cloudflare Worker environment variables
 * @returns An instance of OAuthHelpers
 */
declare function getOAuthApi<Env = Cloudflare.Env>(options: OAuthProviderOptions<Env>, env: Env): OAuthHelpers;
/**
 * Error class for OAuth operations
 * Carries OAuth error code and description for proper error responses
 */
/**
 * Options accepted by the {@link OAuthError} constructor.
 */
interface OAuthErrorOptions {
  /**
   * Human-readable text returned in the `error_description` field.
   */
  description: string;
  /**
   * HTTP status code for the error response. Defaults to `400`.
   */
  statusCode?: number;
  /**
   * Additional response headers.
   *
   * For transient failures (e.g. upstream rate limits), set
   * `Retry-After` here so well-behaved clients back off instead of
   * retry-storming. Per RFC 7231 §7.1.3 the value may be either a
   * number of seconds or an HTTP-date.
   */
  headers?: Record<string, string>;
}
/**
 * Structured OAuth 2.0 token-endpoint error.
 *
 * Throw from a `tokenExchangeCallback` or any code it calls to surface a
 * standard OAuth token response (`{ error, error_description }`) instead of a
 * generic `500 Internal Server Error`.
 *
 * Anything thrown that is **not** an `OAuthError` continues to surface as
 * a 500 so unexpected failures remain visible — the provider does not
 * catch-everything-and-return-400.
 *
 * @example
 * ```ts
 * import { OAuthError } from '@cloudflare/workers-oauth-provider';
 *
 * tokenExchangeCallback: async (options) => {
 *   if (options.grantType === 'refresh_token') {
 *     // refreshUpstream() may throw OAuthError from any depth
 *     return { newProps: await refreshUpstream(options.props) };
 *   }
 * }
 *
 * async function refreshUpstream(props) {
 *   const res = await fetch(...);
 *   if (res.status === 401) {
 *     throw new OAuthError('invalid_grant', { description: 'upstream refresh token is invalid' });
 *   }
 *   if (res.status === 429) {
 *     // Mirror upstream's Retry-After if present, otherwise pick a default.
 *     throw new OAuthError('temporarily_unavailable', {
 *       description: 'upstream rate limited',
 *       statusCode: 429,
 *       headers: { 'Retry-After': res.headers.get('retry-after') ?? '60' },
 *     });
 *   }
 *   return await res.json();
 * }
 * ```
 */
declare class OAuthError extends Error {
  /** OAuth 2.0 error code. */
  readonly code: string;
  /** Options controlling the OAuth error response. */
  readonly options: OAuthErrorOptions & {
    statusCode: number;
  };
  /** Human-readable description sent in the `error_description` field. */
  readonly description: string;
  /** HTTP status code for the error response. */
  readonly statusCode: number;
  /** Additional response headers. */
  readonly headers?: Record<string, string>;
  constructor(code: string, options: OAuthErrorOptions);
}
/** Options accepted by the {@link ExternalTokenError} constructor. */
interface ExternalTokenErrorOptions {
  /**
   * Public description returned in the OAuth `error_description` field.
   * Do not include credentials, upstream response bodies, or private diagnostics.
   */
  description: string;
  /** HTTP status returned to the protected-resource client. */
  statusCode: number;
  /** Additional public response headers, such as `Retry-After`. */
  headers?: Record<string, string>;
  /**
   * Minimum scopes needed for the protected-resource operation.
   *
   * For `403 insufficient_scope`, these values are validated, deduplicated,
   * and added to the synthesized `WWW-Authenticate` challenge. Each value must
   * use the OAuth scope-token grammar from RFC 6749 §3.3.
   */
  requiredScopes?: string[];
}
/**
 * Intentional public error from an external bearer-token validator.
 *
 * Throw only from `resolveExternalToken` when an expected validation outcome
 * should become a structured protected-resource response. Ordinary errors and
 * {@link OAuthError} retain their pre-existing behavior and propagate as
 * unexpected failures.
 */
declare class ExternalTokenError extends Error {
  /** OAuth error code returned in the response body and, when applicable, challenge. */
  readonly code: OAuthTokenErrorCode;
  /** Public description returned as `error_description`. */
  readonly description: string;
  /** HTTP status returned to the protected-resource client. */
  readonly statusCode: number;
  /** Additional public response headers. */
  readonly headers?: Record<string, string>;
  /** Minimum scopes for an `insufficient_scope` challenge. */
  readonly requiredScopes?: string[];
  /**
   * Creates an intentional external-token validation error.
   * @param code - Standard OAuth error code to return
   * @param options - Public response details
   */
  constructor(code: OAuthTokenErrorCode, options: ExternalTokenErrorOptions);
}
/**
 * Thrown when fetching a Client ID Metadata Document (CIMD) fails — the
 * server-to-server fetch errored, timed out, or returned an invalid document.
 * Distinct from a client that simply does not exist, which is reported as a
 * null client lookup result.
 *
 * At the token endpoint the provider handles this itself: the wire response
 * stays a generic `invalid_client` / "Client not found", and the failure is
 * reported through the `onError` hook's `internal` field (category
 * `client-id-metadata-document`) together with the originating `request`.
 *
 * `OAuthHelpers` methods that look up clients (`lookupClient`, and methods
 * built on it such as `exchangeToken`) let this error propagate to the
 * caller. Callers that previously relied on a `null` result for these
 * failures should catch it to preserve their error contract.
 */
declare class CimdFetchError extends Error {
  /** Stable reason slug suitable for telemetry and control flow. */
  readonly reason: "metadata_resolution_failed";
  /** The CIMD URL whose fetch or validation failed. */
  readonly metadataUrl: string;
  /** The underlying failure message (e.g. "Failed to fetch client metadata: HTTP 403"). */
  readonly detail: string;
  /**
   * Creates an error for a failed CIMD fetch or validation.
   * @param metadataUrl - The CIMD URL that could not be resolved
   * @param cause - The underlying fetch or validation failure
   */
  constructor(metadataUrl: string, cause: unknown);
}
/**
 * Validates a resource URI per RFC 8707 Section 2
 * @param uri - The URI string to validate
 * @returns true if valid, false otherwise
 */
declare function validateResourceUri(uri: string): boolean;
/**
 * Checks if a requested resource matches a granted resource.
 * When originOnly is true, compares only the origin (scheme + host + port),
 * allowing path-aware resources to match origin-only grants.
 */
declare function resourceMatches(requested: string, granted: string, originOnly: boolean): boolean;
/**
 * Decodes a base64url-encoded string to bytes.
 */
declare function base64UrlToBytes(base64Url: string): Uint8Array;
/**
 * Parses a base64url-encoded JWT JSON part into an object.
 */
declare function parseJwtJsonPart(encoded: string): Record<string, unknown>;
/**
 * Gets WebCrypto import and verify parameters for supported JOSE algorithms.
 */
declare function getJwtCryptoAlgorithms(alg: string): {
  importAlgorithm: Parameters<SubtleCrypto['importKey']>[2];
  verifyAlgorithm: Parameters<SubtleCrypto['verify']>[0];
};
//#endregion
export { AuthRequest, AuthorizationError, type AuthorizationErrorCode, type AuthorizationErrorOptions, CimdFetchError, ClientInfo, ClientRegistrationCallbackOptions, ClientRegistrationCallbackResult, CompleteAuthorizationOptions, type EmaClaimsMapper, type EmaClaimsMapperInput, type EmaClaimsMapperResult, type EmaIdJagClaims, type EmaOptions, type EmaTrustedIssuer, type EmaTrustedIssuerResolver, type EmaTrustedIssuerResolverInput, type EmaValidationError, ExchangeTokenOptions, ExternalTokenError, ExternalTokenErrorOptions, Grant, GrantSummary, GrantType, ListOptions, ListResult, OAuthError, OAuthErrorOptions, OAuthHelpers, OAuthProvider, OAuthProvider as default, OAuthProviderOptions, OAuthTokenErrorCode, PurgeOptions, PurgeResult, ResolveExternalTokenInput, ResolveExternalTokenResult, Token, TokenBase, TokenExchangeCallbackOptions, TokenExchangeCallbackResult, TokenSummary, base64UrlToBytes, getJwtCryptoAlgorithms, getOAuthApi, isValidOAuthScopeToken, parseJwtJsonPart, resourceMatches, validateResourceUri };