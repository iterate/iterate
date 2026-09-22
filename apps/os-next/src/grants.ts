import { z } from "zod";
import {
  CimdFetchError,
  OAuthProvider,
  type GrantSummary,
} from "@cloudflare/workers-oauth-provider";
import type { StreamEventInput } from "iterate/next/stream/processor";
import { RpcTarget } from "capnweb";
import { codedError, isLocalOrigin } from "iterate/next/lib";
import { authorizationCodeRequest } from "iterate/next/oauth";
import { type GrantEnded, type GrantMinted } from "./account/contract.ts";
import type { PlatformAddresses } from "./app-config.ts";
import type { Env } from "./env.ts";
import { directory } from "./directory.ts";
import {
  authorizationOf,
  oauthHelpers,
  parseAuthorization,
  providerOptions,
  revokeGrant,
  type GrantProps,
  type Authorization,
} from "./oauth.ts";
import { ClientDisplayUrl, clientDisplay } from "./client-display.ts";
import { publishGlobalFact } from "./session.ts";

const DisplayMetadata = z.object({
  clientName: z.string().optional(),
  tokenKind: z.string().optional(),
  logoUri: ClientDisplayUrl.optional().catch(undefined),
  clientDomain: z.string().optional(),
});
const MintInput = z.object({
  name: z.string().trim().min(1).max(100),
  projects: z.array(z.string()).min(1),
  /** A public CIMD client for a separately provisioned device. */
  clientId: z.url({ protocol: /^https$/ }).optional(),
  /** Epoch ms. Default 30 days; at most ten years — a device that can neither refresh nor
   *  reflash itself is retired by revocation from the sessions list, not by a clock. */
  expiresAt: z.number().int().positive().optional(),
});

/** Whether this deployment mints personal access tokens: a bearer that acts as a person must only
 *  ever travel over TLS — or to the local worker (`localhost`, `127.0.0.1`), where `pnpm dev` and
 *  the e2e vitest project speak plain http on the loopback. Any other http issuer is refused. */
const mintsPersonalAccessTokens = (issuer: string): boolean =>
  issuer.startsWith("https:") || isLocalOrigin(issuer);

/** Account capabilities are consented independently of project access. */
export class GrantsRpcTarget extends RpcTarget {
  readonly #env: Env;
  readonly #ctx: ExecutionContext;
  readonly #auth: Authorization;
  /** where this session reached the platform (app-config.ts `platformAddressesOf`) */
  readonly #addresses: PlatformAddresses;
  constructor(env: Env, ctx: ExecutionContext, auth: Authorization, addresses: PlatformAddresses) {
    super();
    this.#env = env;
    this.#ctx = ctx;
    this.#auth = auth;
    this.#addresses = addresses;
  }
  #account() {
    const grant = this.#auth.grant;
    if (!grant?.scope.includes("account"))
      throw codedError(
        "FORBIDDEN",
        "Account permission is required to manage sessions and personal access tokens.",
      );
    return { sub: grant.userId, email: grant.email, reach: this.#auth.reach, grant };
  }
  /** An ACCOUNT FACT on `/users/<userId>` — a token minted, a grant ended — stamped with this
   *  caller; best-effort and async, as session.ts `publishGlobalFact` says: the provider is the
   *  truth for the grant, this is the person's record of it. */
  #publishAccountFact(userId: string, fact: StreamEventInput): void {
    publishGlobalFact(
      {
        contextNamespace: this.#env.ITERATE_CONTEXT,
        waitUntil: (promise) => this.#ctx.waitUntil(promise),
      },
      `/users/${userId}`,
      "account",
      fact,
      { principal: this.#auth.principal, grant: this.#auth.grant?.grantId },
    );
  }
  /** Any client can end its own grant. It cannot address another user's session. */
  async endCurrent() {
    const grant = this.#auth.grant;
    if (!grant) throw codedError("FORBIDDEN", "The administrator credential has no user session.");
    const ended = await revokeGrant(this.#env, this.#addresses, grant);
    this.#publishAccountFact(grant.userId, {
      type: "events.iterate.com/account/grant-ended",
      idempotencyKey: `account/grant-ended/${grant.grantId}`,
      payload: { grantId: grant.grantId } satisfies GrantEnded,
    });
    return ended;
  }

  /** Provider pagination is the inventory; D1 adds use and revocation state only. */
  async list(cursor?: string) {
    const env = this.#env;
    const session = this.#account();
    const page = await oauthHelpers(env, this.#addresses).listUserGrants(session.sub, {
      limit: 50,
      cursor,
    });
    type Activity = {
      grant_id: string;
      last_used_at: number | null;
      revoked_at: number | null;
      cleanup_pending: number;
    };
    const activity =
      await env.DB.prepare(`SELECT grant_id, last_used_at, revoked_at, cleanup_pending
FROM oauth_activity WHERE user_id = ? AND (grant_id IN (${page.items.map(() => "?").join(",") || "NULL"}) OR cleanup_pending = 1)`)
        .bind(session.sub, ...page.items.map((grant) => grant.id))
        .all<Activity>();
    const records = new Map(activity.results.map((row) => [row.grant_id, row]));
    const items = page.items.flatMap((grant) => {
      const row = records.get(grant.id);
      records.delete(grant.id);
      if (row?.revoked_at && !row.cleanup_pending) return [];
      const metadata = DisplayMetadata.parse(grant.metadata ?? {});
      // The provider stores an unexchanged grant with the code's ten-minute KV TTL.
      const expiresAt = (grant.expiresAt ?? grant.createdAt + 600) * 1000;
      return [
        {
          id: grant.id,
          name: metadata.clientName || grant.clientId,
          clientId: grant.clientId,
          logoUri: metadata.logoUri,
          clientDomain: metadata.clientDomain,
          kind: !grant.expiresAt
            ? "Pending sign-in"
            : metadata.tokenKind === "device"
              ? "Device"
              : metadata.tokenKind === "personal"
                ? "Personal access token"
                : "Session",
          createdAt: grant.createdAt * 1000,
          expiresAt,
          lastUsedAt: row?.last_used_at ?? null,
          current: grant.id === session.grant.grantId,
          cleanupPending: Boolean(row?.cleanup_pending),
          expired: Boolean(expiresAt && expiresAt <= Date.now()),
        },
      ];
    });
    // A cleanup failure remains actionable even after the provider row disappeared.
    const cleanup = [...records.values()]
      .filter((row) => row.cleanup_pending)
      .map((row) => ({
        id: row.grant_id,
        name: "Revoked session",
        clientId: undefined,
        logoUri: undefined,
        clientDomain: undefined,
        kind: "Session",
        createdAt: 0,
        expiresAt: null,
        lastUsedAt: row.last_used_at,
        current: row.grant_id === session.grant.grantId,
        cleanupPending: true,
        expired: false,
      }));
    return {
      items: [...items, ...cleanup],
      cursor: page.cursor,
      projects: await directory(env.DB).reachableProjects(session.reach),
      canMintToken: mintsPersonalAccessTokens(this.#addresses.platformOrigin),
    };
  }

  /** Ownership comes from an existing marker or a full provider inventory scan.
   * An arbitrary foreign grant id never creates a D1 row. */
  async end(grantId: string) {
    const env = this.#env;
    const session = this.#account();
    const marker = await env.DB.prepare(
      "SELECT revoked_at FROM oauth_activity WHERE user_id = ? AND grant_id = ?",
    )
      .bind(session.sub, grantId)
      .first<{ revoked_at: number | null }>();
    if (!marker) {
      let owned: GrantSummary | undefined;
      let cursor: string | undefined;
      do {
        const page = await oauthHelpers(env, this.#addresses).listUserGrants(session.sub, {
          cursor,
        });
        owned = page.items.find((grant) => grant.id === grantId);
        cursor = page.cursor;
      } while (!owned && cursor);
      if (!owned) throw codedError("GRANT_NOT_FOUND", "Session not found");
    }
    const ended = await revokeGrant(env, this.#addresses, { userId: session.sub, grantId });
    this.#publishAccountFact(session.sub, {
      type: "events.iterate.com/account/grant-ended",
      idempotencyKey: `account/grant-ended/${grantId}`,
      payload: { grantId } satisfies GrantEnded,
    });
    return ended;
  }

  /** The console's own OAuth client the personal-token exchange runs through: the client id
   * metadata document at `/.auth/client.json` on an HTTPS issuer; on the local worker (a plain-http
   * client id is no CIMD client) a public client registered with the provider, as the browser
   * session's login registers one (browser-session.ts). The local harness's KV does not promise
   * read-your-write (a lookup right after the put has missed under load), and the exchange below
   * reads the row three times — so the id is returned only once the provider sees it. */
  async #consoleClientId(issuer: string, redirectUri: string): Promise<string> {
    if (!isLocalOrigin(issuer)) return `${issuer}/.auth/client.json`;
    const helpers = oauthHelpers(this.#env, this.#addresses);
    const client = await helpers.createClient({
      clientName: new URL(issuer).host,
      redirectUris: [redirectUri],
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
    });
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await helpers.lookupClient(client.clientId)) return client.clientId;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("The local console client did not become visible to the provider.");
  }

  /** A PERSONAL ACCESS TOKEN: one finite OAuth grant of this user's — 30 days unless `expiresAt`
   * says longer (up to ten years, for a device that holds it), scoped to the `projects` named (each
   * one the user reaches), revocable from `list`/`end` like any grant — whose
   * access token is answered ONCE and never stored readable; it carries no refresh credential
   * (`tokenExchangeCallback`, oauth.ts, refuses a refresh of a personal grant). The bearer opens
   * `/api`, `/mcp` and a project host of a covered project as the user (`authorizationForToken`).
   * The console's client, or the device's public CIMD client, performs the exchange in process. */
  async mint(input: unknown) {
    const env = this.#env;
    const ctx = this.#ctx;
    const session = this.#account();
    if (!(await authorizationOf(env, session.grant)))
      throw codedError("UNAUTHENTICATED", "This session has ended. Sign in again.");
    const data = MintInput.parse(input);
    const { platformOrigin: issuer, api, mcp } = this.#addresses;
    if (!mintsPersonalAccessTokens(issuer))
      throw codedError("FORBIDDEN", "Personal access tokens require an HTTPS deployment.");
    const projects = (await directory(env.DB).reachableProjects(session.reach))
      .filter((project) => data.projects.includes(project.id))
      .map((project) => project.id);
    if (!projects.length) throw codedError("FORBIDDEN", "Choose a project you can access.");
    const redirectUri = `${data.clientId ? new URL(data.clientId).origin : issuer}/.auth/callback`;
    const clientId = data.clientId || (await this.#consoleClientId(issuer, redirectUri));
    const helpers = oauthHelpers(env, this.#addresses);
    const client = data.clientId
      ? await helpers.lookupClient(clientId).catch((error: unknown) => {
          if (!(error instanceof CimdFetchError)) throw error;
          throw codedError(
            "INVALID_INPUT",
            "The device's OAuth metadata could not be loaded. Try preparing the device again.",
            { clientId, detail: error.detail },
          );
        })
      : null;
    if (data.clientId && (!client || client.tokenEndpointAuthMethod !== "none"))
      throw codedError("INVALID_INPUT", "A device needs a public OAuth client metadata document.");
    const flow = await authorizationCodeRequest({
      issuer,
      clientId,
      redirectUri,
      resources: [api, mcp],
    });
    const auth = await parseAuthorization(env, new Request(flow.url));
    const expiresAt = Math.min(
      data.expiresAt ?? Date.now() + 30 * 24 * 3600_000,
      Date.now() + 10 * 365 * 24 * 3600_000,
    );
    if (expiresAt < Date.now() + 60_000)
      throw codedError("INVALID_INPUT", "expiresAt must be at least a minute away.");
    const approved = await helpers.completeAuthorization({
      request: auth,
      userId: session.sub,
      scope: ["iterate"],
      revokeExistingGrants: false,
      metadata: {
        ...clientDisplay(client, clientId),
        clientName: data.name,
        tokenKind: data.clientId ? "device" : "personal",
      },
      props: {
        kind: "personal",
        version: 2,
        userId: session.sub,
        email: session.email,
        projects,
        deadline: expiresAt,
      } satisfies GrantProps,
    });
    const code = new URL(approved.redirectTo).searchParams.get("code");
    if (!code) throw new Error("The token authorization did not produce a code.");
    // Personal token minting runs the code→token exchange through the SAME provider gate in process
    // (browser apps hit its public endpoint instead).
    const response = await new OAuthProvider(providerOptions(env, this.#addresses)).fetch(
      new Request(`${issuer}/oauth2/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_verifier: flow.verifier,
          code,
        }),
      }),
      env,
      ctx,
    );
    if (!response.ok) throw new Error(`Token exchange refused (${response.status}).`);
    const tokens = z
      .object({
        token_type: z.literal("bearer"),
        access_token: z.string(),
        // The provider needs a finite refresh lifetime to expire its grant record.
        // This credential is discarded here; the exchange callback refuses its use.
        refresh_token: z.string(),
      })
      .parse(await response.json());
    // The provider's access token is `<userId>:<grantId>:<secret>` (oauth-provider.ts): the grant's
    // id is its middle — the only place the mint learns it. The fact of the mint, on the account.
    const [, grantId = ""] = tokens.access_token.split(":");
    this.#publishAccountFact(session.sub, {
      type: "events.iterate.com/account/grant-minted",
      idempotencyKey: `account/grant-minted/${grantId}`,
      payload: { grantId, name: data.name, projects, expiresAt } satisfies GrantMinted,
    });
    return { token: tokens.access_token, expiresAt };
  }
}
