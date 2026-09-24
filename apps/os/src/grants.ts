import { z } from "zod";
import {
  CimdFetchError,
  OAuthProvider,
  type GrantSummary,
} from "@cloudflare/workers-oauth-provider";
import { RpcTarget } from "capnweb";
import { codedError, isLocalOrigin } from "iterate/next/lib";
import { authorizationCodeRequest } from "iterate/next/oauth";
import { type GrantEnded, type GrantMinted } from "./account/contract.ts";
import type { PlatformAddresses } from "./app-config.ts";
import type { Env } from "./env.ts";
import { ControlPlane } from "./control-plane/edge.ts";
import {
  accountStateOf,
  authorizationOf,
  oauthHelpers,
  parseAuthorization,
  providerOptions,
  revokeGrant,
  type GrantProps,
  type Authorization,
} from "./oauth.ts";
import { ClientDisplayUrl, clientDisplay } from "./client-display.ts";
import { appendAccountFacts, publishAccountFact } from "./session.ts";

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
  /** AN ACCOUNT FACT THE VERB AWAITS — a grant's end: from the moment it lands, every admission of
   *  the grant is refused (oauth.ts `grantIsRevoked` reads the account's `endedGrants`), whatever
   *  the provider's rows still say. Keyed on the grant, and stamped `source.platform`
   *  (session.ts `appendAccountFacts`): the account folds nothing else, so an end a person appends
   *  themselves revokes nothing. */
  async #landGrantEnded(userId: string, grantId: string): Promise<void> {
    await appendAccountFacts(
      this.#env.ITERATE_CONTEXT,
      userId,
      {
        type: "events.iterate.com/account/grant-ended",
        idempotencyKey: `account/grant-ended/${grantId}`,
        payload: { grantId } satisfies GrantEnded,
      },
      { principal: this.#auth.principal, grant: this.#auth.grant?.grantId },
    );
  }
  /** Any client can end its own grant. It cannot address another user's session. */
  async endCurrent() {
    const grant = this.#auth.grant;
    if (!grant) throw codedError("FORBIDDEN", "The administrator credential has no user session.");
    await this.#landGrantEnded(grant.userId, grant.grantId);
    return revokeGrant(this.#env, this.#addresses, grant);
  }

  /** Provider pagination is the inventory; the person's own account (src/account/contract.ts) says
   *  which grants have ended and when each was last used. */
  async list(cursor?: string) {
    const env = this.#env;
    const session = this.#account();
    const [page, account] = await Promise.all([
      oauthHelpers(env, this.#addresses).listUserGrants(session.sub, { limit: 50, cursor }),
      accountStateOf(env, session.sub),
    ]);
    const items = page.items.flatMap((grant) => {
      if (account.endedGrants[grant.id]) return [];
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
          lastUsedAt: account.grantUses[grant.id]?.at ?? null,
          current: grant.id === session.grant.grantId,
          expired: Boolean(expiresAt && expiresAt <= Date.now()),
        },
      ];
    });
    return {
      items,
      cursor: page.cursor,
      projects: await new ControlPlane(env.CONTROL_PLANE).reachableProjects(session.reach),
      canMintToken: mintsPersonalAccessTokens(this.#addresses.platformOrigin),
    };
  }

  /** Ownership comes from the account (a grant already ended there) or a full provider inventory
   * scan — an arbitrary foreign grant id ends nothing. The end lands on the account FIRST and is
   * awaited (the revocation truth); then the provider's rows go. */
  async end(grantId: string) {
    const env = this.#env;
    const session = this.#account();
    const account = await accountStateOf(env, session.sub);
    if (!account.endedGrants[grantId]) {
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
    await this.#landGrantEnded(session.sub, grantId);
    return revokeGrant(env, this.#addresses, { userId: session.sub, grantId });
  }

  /** The console's own OAuth client the personal-token exchange runs through: the client id
   * metadata document at `/.auth/client.json` on an HTTPS issuer; on the local worker (a plain-http
   * client id is no CIMD client) a public client registered with the provider, as the browser
   * session's login registers one. The local harness's KV does not promise
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
    const projects = (await new ControlPlane(env.CONTROL_PLANE).reachableProjects(session.reach))
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
    // Best-effort and async (session.ts `publishAccountFact`): the provider is the truth for the
    // grant, this is the person's record of it.
    const [, grantId = ""] = tokens.access_token.split(":");
    publishAccountFact(
      {
        contextNamespace: this.#env.ITERATE_CONTEXT,
        waitUntil: (promise) => this.#ctx.waitUntil(promise),
      },
      session.sub,
      {
        type: "events.iterate.com/account/grant-minted",
        idempotencyKey: `account/grant-minted/${grantId}`,
        payload: { grantId, name: data.name, projects, expiresAt } satisfies GrantMinted,
      },
      { principal: this.#auth.principal, grant: this.#auth.grant?.grantId },
    );
    return { token: tokens.access_token, expiresAt };
  }
}
