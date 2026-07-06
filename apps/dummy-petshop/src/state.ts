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

/** One registered OAuth client: its secret and how long its access tokens live. */
export interface OauthClient {
  clientSecret: string;
  accessTokenTtlSeconds: number;
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
  /** Current webhook HMAC secret; rotatable via the backdoor. */
  webhookSigningSecret: string;
  /** While > 0, POST /oauth/token returns 500 and decrements — for retry specs. */
  tokenEndpointFailuresRemaining: number;
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
    if (existing) return existing;
    const initial: PetshopState = {
      accessTokenEpoch: 0,
      clients: {
        [DEFAULT_CLIENT_ID]: {
          clientSecret: DEFAULT_CLIENT_SECRET,
          accessTokenTtlSeconds: DEFAULT_ACCESS_TTL_SECONDS,
        },
      },
      revokedRefreshTokenIds: [],
      // Random per environment so signature specs prove real verification,
      // not a hardcoded constant. Persisted immediately so it is stable
      // across reads; readable (and rotatable) through the backdoor.
      webhookSigningSecret: crypto.randomUUID(),
      tokenEndpointFailuresRemaining: 0,
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
  }): Promise<{ clientId: string; clientSecret: string }> {
    const state = await this.#load();
    const clientId = `petshop-client-${crypto.randomUUID().slice(0, 8)}`;
    const clientSecret = crypto.randomUUID();
    state.clients[clientId] = {
      clientSecret,
      accessTokenTtlSeconds: input.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TTL_SECONDS,
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

  async rotateSigningSecret(): Promise<string> {
    const state = await this.#load();
    state.webhookSigningSecret = crypto.randomUUID();
    await this.#save(state);
    return state.webhookSigningSecret;
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
