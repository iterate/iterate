/**
 * How long an access token lives. Deliberately short so integration e2e hits
 * real expiry (and therefore real refresh) without waiting an hour.
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
 * The seeded GitHub-App installation every environment starts with.
 * Well-known ids, like the OAuth client above — but the seed carries NO
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
 * side's secret. `webhookSecret` is the key its webhooks are signed with.
 */
export interface GithubApp {
  appId: string;
  /** RS256 SPKI PEM (`-----BEGIN PUBLIC KEY-----`); "" until one is registered. */
  publicKeyPem: string;
  installationId: string;
  webhookSecret: string;
  /** The GitHub fake's (github.ts) view of the installation, filled by `registerApp` (absent on
   *  an installation registered before the fake existed): the App's URL handle
   *  (`/apps/<appSlug>/installations/new`), its Callback URL, the account it is installed on, the
   *  users who reach it (`/user/installations`) and the OAuth client they authorize. */
  appSlug?: string;
  callbackUrl?: string;
  account?: GithubAccount;
  users?: GithubInstallationUser[];
  oauthClientId?: string;
}

/** The account (a user or an organization) a GitHub App installation is on. */
export interface GithubAccount {
  login: string;
  id: number;
  type: "Organization" | "User";
}

/** A user who reaches a GitHub App installation, and their role on its account. */
export interface GithubInstallationUser {
  login: string;
  role: "admin" | "member";
}

/**
 * The whole service's mutable state — one JSON blob in one Durable Object.
 * Tokens are sealed AES-GCM blobs (seal.ts), so only the things that genuinely must be shared and
 * mutable live here: the client registry, revocation facts, the fakes' records and scheduled
 * token-endpoint failures.
 */
export interface PetshopState {
  /** Per-client revocation epochs. A token seals the epoch for its `clientId`,
   * so concurrent integration tests can expire their own credentials without
   * invalidating an unrelated client's freshly refreshed token. An id with a colon is one
   * account's (`graphqlSessionAccountClientId`, `tesco-login:<email>`), and the
   * `MINTED_RECORDS_KEPT` most recently revoked accounts are kept; a minted client's epoch goes
   * with the client. */
  accessTokenEpochs: Record<string, number>;
  /** The seeded client and the newest `MINTED_RECORDS_KEPT` minted ones, oldest first. */
  clients: Record<string, OauthClient>;
  /** `jti` values of revoked refresh tokens (authorization-server.ts; the Slack fake's bot tokens
   * are refresh tokens). The newest `RECORDS_KEPT` are kept. */
  revokedRefreshTokenIds: string[];
  /** `jti` values of authorization codes already exchanged — codes are
   * single-use (RFC 6749 §4.1.2), so a replayed code is rejected. The newest
   * `MINTED_RECORDS_KEPT` are kept, far more than are exchanged while a code lives. */
  usedAuthorizationCodeIds: string[];
  /** Scheduled POST /oauth/token failures, scoped by OAuth client so one test's
   * fault injection cannot break another concurrently running integration. */
  tokenEndpointFailuresRemainingByClient: Record<string, number>;
  /** Registered GitHub App installations, keyed by `installationId` (the path
   * segment of `POST /app/installations/<id>/access_tokens`). Seeded with the
   * well-known default; extended/replaced via `POST /__backdoor/apps`. */
  apps: Record<string, GithubApp>;
  /** Installation ids in registration order, oldest first — what the registry's cap drops from.
   *  Absent in a state saved before it existed. */
  installationOrder?: string[];
  /** What the Slack fake's (slack.ts) `chat.postMessage` recorded, per workspace, newest last. */
  slackMessages?: Record<string, SlackMessage[]>;
  /** The GitHub fake's pull requests (their files) and the check runs posted to it, per
   *  installation, newest last. */
  githubPulls?: Record<string, GithubPull[]>;
  githubCheckRuns?: Record<string, GithubCheckRun[]>;
  /** The RS256 key the Google and Cloudflare fakes sign ID tokens with (oidc.ts), minted on first
   *  use and kept, so every isolate's ID tokens verify against the one published JWKS. */
  oidcSigningKey?: OidcSigningKey;
}

/** A pull request the GitHub fake serves (`/__backdoor/github/pulls` seeds it). */
export interface GithubPull {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  files: { filename: string; status: string; patch: string }[];
}

/** A check run posted to the GitHub fake. */
export interface GithubCheckRun {
  id: number;
  owner: string;
  repo: string;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  external_id: string | null;
  output: unknown;
}

/** An RS256 key pair as JWKs, and the `kid` its ID tokens name. */
export interface OidcSigningKey {
  kid: string;
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
}

/** One `chat.postMessage` the Slack fake accepted. */
export interface SlackMessage {
  channel: string;
  text: string;
  ts: string;
}

/** How many GitHub App installations, revoked token ids, and Slack workspaces (and messages per
 *  workspace) are kept: every e2e run mints its own, so the oldest go first (never the seeded
 *  installation). */
const RECORDS_KEPT = 200;

/**
 * How many minted OAuth clients, account revocation epochs and spent authorization codes are
 * kept, the oldest going first. The state is one stored value that every change rewrites and every
 * read copies whole, so its size is the cost of each call to the Durable Object; kept unbounded,
 * those calls queue behind the storage writes until workerd resets the object. A test uses its
 * client, account or code for minutes, while the e2e suites mint fewer than 700 clients an hour.
 */
const MINTED_RECORDS_KEPT = 500;

const MINTED_CLIENT_ID_PREFIX = "petshop-client-";

/** Drops what `MINTED_RECORDS_KEPT` does not keep. A minted client's revocation epoch and its
 *  scheduled token-endpoint failures go with it; the seeded client and the endpoint-wide epochs
 *  (`graphql-session-login`, a GitHub App's) stay. */
function dropOldestMintedRecords(state: PetshopState): void {
  const mintedClientIds = Object.keys(state.clients).filter((id) =>
    id.startsWith(MINTED_CLIENT_ID_PREFIX),
  );
  for (const clientId of mintedClientIds.slice(0, -MINTED_RECORDS_KEPT))
    delete state.clients[clientId];
  for (const byClient of [state.accessTokenEpochs, state.tokenEndpointFailuresRemainingByClient])
    for (const clientId of Object.keys(byClient))
      if (clientId.startsWith(MINTED_CLIENT_ID_PREFIX) && !state.clients[clientId])
        delete byClient[clientId];
  const accountEpochIds = Object.keys(state.accessTokenEpochs).filter((id) => id.includes(":"));
  for (const accountId of accountEpochIds.slice(0, -MINTED_RECORDS_KEPT))
    delete state.accessTokenEpochs[accountId];
  state.usedAuthorizationCodeIds = state.usedAuthorizationCodeIds.slice(-MINTED_RECORDS_KEPT);
}

/** A fake account's numeric id, stable for its login or email: FNV-1a of it — a GitHub user's or organization's id, a Google or Cloudflare subject. */
export function fakeUserIdOf(login: string): number {
  let hash = 0x811c9dc5;
  for (const char of login.toLowerCase()) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  return hash >>> 0;
}

/** A client whose tokens were never expired through the backdoor is at epoch 0. */
export function accessTokenEpochFor(state: PetshopState, clientId: string): number {
  return state.accessTokenEpochs[clientId] ?? 0;
}

/** The seeded default GitHub App installation — well-known ids, no verifying
 * key yet (see {@link GithubApp}); its webhook secret is random per environment,
 * so signature specs prove real verification. */
function defaultGithubApp(): GithubApp {
  return {
    appId: DEFAULT_APP_ID,
    publicKeyPem: "",
    installationId: DEFAULT_INSTALLATION_ID,
    webhookSecret: crypto.randomUUID(),
  };
}

/** Where the state blob is kept: a Durable Object's storage, or a map (memory-state.ts). */
export interface PetshopStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

/**
 * The shop's state and every change to it, over one storage blob. Every method
 * is a single load → mutate → save step. In production it lives inside the one
 * Durable Object (durable-object.ts), whose input gate serializes the methods,
 * so the stateless worker never does read-modify-write races; tests and
 * memory-state.ts run it over a map.
 */
export class PetshopStore {
  readonly #storage: PetshopStorage;

  constructor(storage: PetshopStorage) {
    this.#storage = storage;
  }

  async #load(): Promise<PetshopState> {
    const existing = await this.#storage.get<PetshopState>("state");
    if (existing) return existing;
    const initial: PetshopState = {
      accessTokenEpochs: {},
      clients: {
        [DEFAULT_CLIENT_ID]: {
          clientSecret: DEFAULT_CLIENT_SECRET,
          accessTokenTtlSeconds: DEFAULT_ACCESS_TTL_SECONDS,
        },
      },
      revokedRefreshTokenIds: [],
      usedAuthorizationCodeIds: [],
      tokenEndpointFailuresRemainingByClient: {},
      apps: { [DEFAULT_INSTALLATION_ID]: defaultGithubApp() },
      installationOrder: [DEFAULT_INSTALLATION_ID],
    };
    await this.#storage.put("state", initial);
    return initial;
  }

  async #save(state: PetshopState): Promise<void> {
    dropOldestMintedRecords(state);
    await this.#storage.put("state", state);
  }

  async getState(): Promise<PetshopState> {
    return await this.#load();
  }

  async createClient(input: {
    redirectUris?: string[];
    public?: boolean;
  }): Promise<{ clientId: string; clientSecret: string }> {
    const state = await this.#load();
    const clientId = `${MINTED_CLIENT_ID_PREFIX}${crypto.randomUUID().slice(0, 8)}`;
    // A public client has no usable secret; a confidential one authenticates with it.
    const clientSecret = input.public ? "" : crypto.randomUUID();
    state.clients[clientId] = {
      clientSecret,
      accessTokenTtlSeconds: DEFAULT_ACCESS_TTL_SECONDS,
      redirectUris: input.redirectUris,
      ...(input.public && { public: true }),
    };
    await this.#save(state);
    return { clientId, clientSecret };
  }

  async expireAccessTokens(clientId: string): Promise<number> {
    const state = await this.#load();
    const next = accessTokenEpochFor(state, clientId) + 1;
    // re-inserted, so the order of the epochs is the order they were last revoked in
    delete state.accessTokenEpochs[clientId];
    state.accessTokenEpochs[clientId] = next;
    await this.#save(state);
    return next;
  }

  /** A long-lived token (see `revokedRefreshTokenIds`) stops working. */
  async revokeToken(tokenId: string): Promise<void> {
    const state = await this.#load();
    state.revokedRefreshTokenIds = [
      ...state.revokedRefreshTokenIds.filter((id) => id !== tokenId),
      tokenId,
    ].slice(-RECORDS_KEPT);
    await this.#save(state);
  }

  /** Consume a single-use authorization code by its jti. Returns true the
   * first time, false on replay (RFC 6749 §4.1.2). */
  async consumeAuthorizationCode(codeId: string): Promise<boolean> {
    const state = await this.#load();
    if (state.usedAuthorizationCodeIds.includes(codeId)) return false;
    state.usedAuthorizationCodeIds.push(codeId);
    await this.#save(state);
    return true;
  }

  /**
   * Register (or replace) a GitHub App installation's verifying key — how the
   * OS side installs the PUBLIC key matching the private key it will sign App
   * JWTs with. Defaults the ids to the well-known seed so the common case is
   * `{ publicKeyPem }`; a replace keeps the existing appId/webhookSecret unless
   * overridden, so registering a key does not silently rotate the webhook
   * secret. The GitHub fake's fields default to the seeded OAuth client and one
   * admin, `petshop-user`; a User account's id is its login's user id. Returns
   * the stored record (webhook secret included) for the caller.
   */
  async registerApp(input: {
    publicKeyPem: string;
    appId?: string;
    installationId?: string;
    webhookSecret?: string;
    appSlug?: string;
    callbackUrl?: string;
    account?: { login: string; id?: number; type?: GithubAccount["type"] };
    users?: GithubInstallationUser[];
    oauthClientId?: string;
  }): Promise<GithubApp> {
    const state = await this.#load();
    const installationId = input.installationId || DEFAULT_INSTALLATION_ID;
    const existing = state.apps[installationId];
    const account = input.account || { login: "petshop-org" };
    const app: GithubApp = {
      appId: input.appId || existing?.appId || DEFAULT_APP_ID,
      publicKeyPem: input.publicKeyPem,
      installationId,
      webhookSecret: input.webhookSecret || existing?.webhookSecret || crypto.randomUUID(),
      appSlug: input.appSlug || DEFAULT_APP_ID,
      callbackUrl: input.callbackUrl,
      account: {
        login: account.login,
        id: account.id || fakeUserIdOf(account.login),
        type: account.type || "Organization",
      },
      users: input.users || [{ login: "petshop-user", role: "admin" }],
      oauthClientId: input.oauthClientId || DEFAULT_CLIENT_ID,
    };
    state.apps[installationId] = app;
    const order = (state.installationOrder || Object.keys(state.apps)).filter(
      (id) => id !== installationId,
    );
    order.push(installationId);
    while (order.length > RECORDS_KEPT) {
      const [oldest] = order.splice(order[0] === DEFAULT_INSTALLATION_ID ? 1 : 0, 1);
      delete state.apps[oldest!];
    }
    state.installationOrder = order;
    await this.#save(state);
    return app;
  }

  async recordSlackMessage(teamId: string, message: SlackMessage): Promise<void> {
    const state = await this.#load();
    const { [teamId]: earlier = [], ...others } = state.slackMessages || {};
    // the workspace moves to the end, so the least recently posted-to are the ones dropped
    state.slackMessages = Object.fromEntries([
      ...Object.entries(others).slice(-(RECORDS_KEPT - 1)),
      [teamId, [...earlier, message].slice(-RECORDS_KEPT)],
    ]);
    await this.#save(state);
  }

  /** The ID-token signing key, minted and saved on first use. */
  async oidcSigningKey(): Promise<OidcSigningKey> {
    const state = await this.#load();
    if (state.oidcSigningKey) return state.oidcSigningKey;
    const pair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    state.oidcSigningKey = {
      kid: crypto.randomUUID(),
      privateJwk: (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey,
      publicJwk: (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey,
    };
    await this.#save(state);
    return state.oidcSigningKey;
  }

  /** Seed a pull request an installation reaches; the newest `RECORDS_KEPT` per installation. */
  async recordGithubPull(installationId: string, pull: GithubPull): Promise<void> {
    const state = await this.#load();
    const pulls = (state.githubPulls?.[installationId] || []).filter(
      (known) =>
        !(known.owner === pull.owner && known.repo === pull.repo && known.number === pull.number),
    );
    state.githubPulls = {
      ...Object.fromEntries(Object.entries(state.githubPulls || {}).slice(-(RECORDS_KEPT - 1))),
      [installationId]: [...pulls, pull].slice(-RECORDS_KEPT),
    };
    await this.#save(state);
  }

  /** Keep a check run an installation posted: its id, numbered from 1 per installation. */
  async recordGithubCheckRun(
    installationId: string,
    run: Omit<GithubCheckRun, "id">,
  ): Promise<GithubCheckRun> {
    const state = await this.#load();
    const runs = state.githubCheckRuns?.[installationId] || [];
    const stored = { ...run, id: runs.length + 1 };
    state.githubCheckRuns = {
      ...Object.fromEntries(Object.entries(state.githubCheckRuns || {}).slice(-(RECORDS_KEPT - 1))),
      [installationId]: [...runs, stored].slice(-RECORDS_KEPT),
    };
    await this.#save(state);
    return stored;
  }

  async setTokenEndpointFailures(clientId: string, times: number): Promise<void> {
    const state = await this.#load();
    if (times === 0) delete state.tokenEndpointFailuresRemainingByClient[clientId];
    else state.tokenEndpointFailuresRemainingByClient[clientId] = times;
    await this.#save(state);
  }

  /** Atomically consume one scheduled failure for this client. */
  async consumeTokenEndpointFailure(clientId: string): Promise<boolean> {
    const state = await this.#load();
    const remaining = state.tokenEndpointFailuresRemainingByClient[clientId] ?? 0;
    if (remaining <= 0) return false;
    if (remaining === 1) delete state.tokenEndpointFailuresRemainingByClient[clientId];
    else state.tokenEndpointFailuresRemainingByClient[clientId] = remaining - 1;
    await this.#save(state);
    return true;
  }
}

/** What every route needs from the shop: its state, and the key that seals its codes and tokens.
 *  `state` is the Durable Object's RPC stub in production and a plain PetshopStore over a map in
 *  tests (memory-state.ts); Pick<> keeps the two structurally interchangeable. */
export interface ShopDeps {
  state: Pick<
    PetshopStore,
    | "getState"
    | "createClient"
    | "expireAccessTokens"
    | "revokeToken"
    | "consumeAuthorizationCode"
    | "setTokenEndpointFailures"
    | "consumeTokenEndpointFailure"
    | "registerApp"
    | "recordSlackMessage"
    | "oidcSigningKey"
    | "recordGithubPull"
    | "recordGithubCheckRun"
  >;
  sealKey: string;
}
