import { DurableObject } from "cloudflare:workers";

/**
 * How long an access token lives unless a backdoor-minted client overrides
 * it. Deliberately short so integration e2e hits real expiry (and therefore
 * real refresh) without waiting an hour.
 */
export const DEFAULT_ACCESS_TTL_SECONDS = 120;

/**
 * The seeded OAuth client every environment starts with. Fixed, well-known
 * values on purpose: this is a dummy service holding only fake data, and
 * specs need credentials that exist before any backdoor call.
 */
export const DEFAULT_CLIENT_ID = "petshop-default";
export const DEFAULT_CLIENT_SECRET = "petshop-default-secret";

/**
 * The seeded GitHub-App installation every environment starts with (design §9
 * P4). Well-known ids, like the OAuth client above — but the seed carries NO
 * verifying key: petshop holds only PUBLIC keys, and the matching private key
 * lives on the OS side, so the App JWT verifier is dead until a public key is
 * registered via `POST /__backdoor/apps`. That is the point being proven, not a
 * gap.
 */
export const DEFAULT_APP_ID = "petshop-app";
export const DEFAULT_INSTALLATION_ID = "petshop-installation";

/** One registered OAuth client: its secret and how long its access tokens live. */
export interface OauthClient {
  clientSecret: string;
  accessTokenTtlSeconds: number;
  /** RFC 7591 dynamically-registered redirect URIs. Empty for the seeded/backdoor
   * clients (they accept any absolute redirect_uri); a DCR client is pinned to
   * exactly what it registered. */
  redirectUris?: string[];
  /** A public client (token_endpoint_auth_method "none", the standard MCP shape)
   * has no secret and authenticates at the token endpoint with PKCE + its
   * client_id in the body instead of HTTP Basic. */
  public?: boolean;
}

/**
 * One registered GitHub App installation. petshop stores ONLY the app's PUBLIC
 * key (RS256 SPKI PEM): the installation-token endpoint verifies a presented App
 * JWT's signature against it, and the matching private key never leaves the OS
 * side's secret (design §9 P4, ADR 0006). `webhookSecret` is the App-webhook
 * HMAC key, the GitHub analogue of `webhookSigningSecret` for OAuth webhooks.
 */
export interface GithubApp {
  appId: string;
  /** RS256 SPKI PEM (`-----BEGIN PUBLIC KEY-----`); "" until one is registered. */
  publicKeyPem: string;
  installationId: string;
  webhookSecret: string;
}

/**
 * The whole service's mutable state — one JSON blob in one Durable Object
 * (integrations-and-secrets-design.md §7 S0). Tokens are sealed AES-GCM
 * blobs (seal.ts), so only the things that genuinely must be shared and
 * mutable live here: the client registry, revocation facts, the webhook
 * signing secret, and backdoor toggles.
 */
export interface PetshopState {
  /** Bumping this invalidates every outstanding access token (they seal the epoch they were minted under). */
  accessTokenEpoch: number;
  clients: Record<string, OauthClient>;
  /** `jti` values of refresh tokens the backdoor has revoked. */
  revokedRefreshTokenIds: string[];
  /** `jti` values of authorization codes already exchanged — codes are
   * single-use (RFC 6749 §4.1.2), so a replayed code is rejected. */
  usedAuthorizationCodeIds: string[];
  /** Current webhook HMAC secret; rotatable via the backdoor. */
  webhookSigningSecret: string;
  /** While > 0, POST /oauth/token returns 500 and decrements — for retry specs. */
  tokenEndpointFailuresRemaining: number;
  /** Registered GitHub App installations, keyed by `installationId` (the path
   * segment of `POST /app/installations/<id>/access_tokens`). Seeded with the
   * well-known default; extended/replaced via `POST /__backdoor/apps`. */
  apps: Record<string, GithubApp>;
}

/** The seeded default GitHub App installation — well-known ids, no verifying
 * key yet (see {@link GithubApp}); its webhook secret is random per environment
 * like `webhookSigningSecret`, so signature specs prove real verification. */
function defaultGithubApp(): GithubApp {
  return {
    appId: DEFAULT_APP_ID,
    publicKeyPem: "",
    installationId: DEFAULT_INSTALLATION_ID,
    webhookSecret: crypto.randomUUID(),
  };
}

/**
 * The one Durable Object behind the whole app (named "global"). Every method
 * is a single load → mutate → save step; the DO's input gate serializes them,
 * so the stateless worker never does read-modify-write races. Route handlers
 * reach it as its RPC stub in production and as a plain instance over an
 * in-memory storage fake in unit tests (see PetshopDeps in worker.ts).
 */
export class PetshopStateDurableObject extends DurableObject {
  async #load(): Promise<PetshopState> {
    const existing = await this.ctx.storage.get<PetshopState>("state");
    if (existing) {
      // Backfill the App registry for a blob written before it existed (the
      // shop's state is one long-lived blob; a preview DO can predate this).
      // Persisted once so the seeded webhook secret is stable across reads.
      if (!existing.apps) {
        existing.apps = { [DEFAULT_INSTALLATION_ID]: defaultGithubApp() };
        await this.ctx.storage.put("state", existing);
      }
      return existing;
    }
    const initial: PetshopState = {
      accessTokenEpoch: 0,
      clients: {
        [DEFAULT_CLIENT_ID]: {
          clientSecret: DEFAULT_CLIENT_SECRET,
          accessTokenTtlSeconds: DEFAULT_ACCESS_TTL_SECONDS,
        },
      },
      revokedRefreshTokenIds: [],
      usedAuthorizationCodeIds: [],
      // Random per environment so signature specs prove real verification,
      // not a hardcoded constant. Persisted immediately so it is stable
      // across reads; readable (and rotatable) through the backdoor.
      webhookSigningSecret: crypto.randomUUID(),
      tokenEndpointFailuresRemaining: 0,
      apps: { [DEFAULT_INSTALLATION_ID]: defaultGithubApp() },
    };
    await this.ctx.storage.put("state", initial);
    return initial;
  }

  async #save(state: PetshopState): Promise<void> {
    await this.ctx.storage.put("state", state);
  }

  async getState(): Promise<PetshopState> {
    return await this.#load();
  }

  async createClient(input: {
    accessTokenTtlSeconds?: number;
    redirectUris?: string[];
    public?: boolean;
  }): Promise<{ clientId: string; clientSecret: string }> {
    const state = await this.#load();
    const clientId = `petshop-client-${crypto.randomUUID().slice(0, 8)}`;
    // A public client has no usable secret; a confidential one authenticates with it.
    const clientSecret = input.public ? "" : crypto.randomUUID();
    state.clients[clientId] = {
      clientSecret,
      accessTokenTtlSeconds: input.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TTL_SECONDS,
      ...(input.redirectUris ? { redirectUris: input.redirectUris } : {}),
      ...(input.public ? { public: true } : {}),
    };
    await this.#save(state);
    return { clientId, clientSecret };
  }

  async expireAccessTokens(): Promise<number> {
    const state = await this.#load();
    state.accessTokenEpoch += 1;
    await this.#save(state);
    return state.accessTokenEpoch;
  }

  async revokeRefreshToken(refreshTokenId: string): Promise<void> {
    const state = await this.#load();
    if (!state.revokedRefreshTokenIds.includes(refreshTokenId)) {
      state.revokedRefreshTokenIds.push(refreshTokenId);
    }
    await this.#save(state);
  }

  /** Consume a single-use authorization code by its jti. Returns true the
   * first time, false on replay (RFC 6749 §4.1.2). Defaults the field so state
   * persisted before this existed still works. */
  async consumeAuthorizationCode(codeId: string): Promise<boolean> {
    const state = await this.#load();
    const used = state.usedAuthorizationCodeIds ?? [];
    if (used.includes(codeId)) return false;
    used.push(codeId);
    state.usedAuthorizationCodeIds = used;
    await this.#save(state);
    return true;
  }

  async rotateSigningSecret(): Promise<string> {
    const state = await this.#load();
    state.webhookSigningSecret = crypto.randomUUID();
    await this.#save(state);
    return state.webhookSigningSecret;
  }

  /**
   * Register (or replace) a GitHub App installation's verifying key — how the
   * OS side installs the PUBLIC key matching the private key it will sign App
   * JWTs with. Defaults the ids to the well-known seed so the common case is
   * `{ publicKeyPem }`; a replace keeps the existing appId/webhookSecret unless
   * overridden, so registering a key does not silently rotate the webhook
   * secret. Returns the stored record (webhook secret included) for the caller.
   */
  async registerApp(input: {
    appId?: string;
    installationId?: string;
    publicKeyPem: string;
    webhookSecret?: string;
  }): Promise<GithubApp> {
    const state = await this.#load();
    const installationId = input.installationId ?? DEFAULT_INSTALLATION_ID;
    const existing = state.apps[installationId];
    const app: GithubApp = {
      appId: input.appId ?? existing?.appId ?? DEFAULT_APP_ID,
      publicKeyPem: input.publicKeyPem,
      installationId,
      webhookSecret: input.webhookSecret ?? existing?.webhookSecret ?? crypto.randomUUID(),
    };
    state.apps[installationId] = app;
    await this.#save(state);
    return app;
  }

  async setTokenEndpointFailures(times: number): Promise<void> {
    const state = await this.#load();
    state.tokenEndpointFailuresRemaining = times;
    await this.#save(state);
  }

  /** Atomically consume one scheduled failure; true means "fail this request". */
  async consumeTokenEndpointFailure(): Promise<boolean> {
    const state = await this.#load();
    if (state.tokenEndpointFailuresRemaining <= 0) return false;
    state.tokenEndpointFailuresRemaining -= 1;
    await this.#save(state);
    return true;
  }
}
