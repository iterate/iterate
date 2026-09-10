import { z } from "zod";
import type { GrantSummary } from "@cloudflare/workers-oauth-provider";
import { RpcTarget } from "capnweb";
import type { Env } from "./control-plane.ts";
import { codedError } from "./lib.ts";
import { directory } from "./directory.ts";
import {
  authorizationCodeRequest,
  exchangeToken,
  oauthAddresses,
  oauthHelpers,
  parseAuthorization,
  revokeGrant,
  type GrantProps,
  type Authorization,
} from "./oauth.ts";

const DisplayMetadata = z.object({
  clientName: z.string().optional(),
  tokenKind: z.string().optional(),
});
const MintInput = z.object({
  name: z.string().trim().min(1).max(100),
  projects: z.array(z.string()).min(1),
});
type Activity = {
  grant_id: string;
  last_used_at: number | null;
  revoked_at: number | null;
  cleanup_pending: number;
};

/** Account capabilities are consented independently of project access. */
export class Grants extends RpcTarget {
  readonly #env: Env;
  readonly #ctx: ExecutionContext;
  readonly #auth: Authorization;
  constructor(env: Env, ctx: ExecutionContext, auth: Authorization) {
    super();
    this.#env = env;
    this.#ctx = ctx;
    this.#auth = auth;
  }
  #account() {
    const grant = this.#auth.grant;
    if (!grant?.scope.includes("account"))
      throw codedError(
        "FORBIDDEN",
        "Account permission is required to manage sessions and API tokens.",
      );
    return { sub: grant.userId, email: grant.email, reach: this.#auth.reach, grant };
  }
  /** Any client can end its own grant. It cannot address another user's session. */
  async endCurrent() {
    const grant = this.#auth.grant;
    if (!grant) throw codedError("FORBIDDEN", "The administrator credential has no user session.");
    return revokeGrant(this.#env, grant);
  }

  /** Provider pagination is the inventory; D1 adds use and revocation state only. */
  async list(cursor?: string) {
    const env = this.#env;
    const session = this.#account();
    const page = await oauthHelpers(env).listUserGrants(session.sub, { limit: 50, cursor });
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
      const expiresAt = grant.expiresAt ? grant.expiresAt * 1000 : null;
      return [
        {
          id: grant.id,
          name: metadata.clientName || grant.clientId,
          kind: metadata.tokenKind === "personal" ? "API token" : "Session",
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
    for (const row of records.values())
      if (row.cleanup_pending)
        items.push({
          id: row.grant_id,
          name: "Revoked session",
          kind: "Session",
          createdAt: 0,
          expiresAt: null,
          lastUsedAt: row.last_used_at,
          current: row.grant_id === session.grant.grantId,
          cleanupPending: true,
          expired: false,
        });
    return {
      items,
      cursor: page.cursor,
      projects: await directory(env.DB).reachableProjects(session.reach),
      canMintToken: oauthAddresses(env).issuer.startsWith("https:"),
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
        const page = await oauthHelpers(env).listUserGrants(session.sub, { cursor });
        owned = page.items.find((grant) => grant.id === grantId);
        cursor = page.cursor;
      } while (!owned && cursor);
      if (!owned) throw codedError("GRANT_NOT_FOUND", "Session not found");
    }
    return revokeGrant(env, { userId: session.sub, grantId });
  }

  /** One finite provider access token, shown once, with no refresh credential. The
   * console's existing CIMD client performs the code exchange in process. */
  async mint(input: unknown) {
    const env = this.#env;
    const ctx = this.#ctx;
    const session = this.#account();
    const data = MintInput.parse(input);
    const { issuer, api, mcp } = oauthAddresses(env);
    if (!issuer.startsWith("https:"))
      throw codedError("FORBIDDEN", "Personal tokens require an HTTPS deployment.");
    const projects = (await directory(env.DB).reachableProjects(session.reach))
      .filter((project) => data.projects.includes(project.id))
      .map((project) => project.id);
    if (!projects.length) throw codedError("FORBIDDEN", "Choose a project you can access.");
    const clientId = `${issuer}/.auth/client.json`;
    const redirectUri = `${issuer}/.auth/callback`;
    const flow = await authorizationCodeRequest({
      issuer,
      clientId,
      redirectUri,
      resources: [api, mcp],
    });
    const helpers = oauthHelpers(env);
    const auth = await parseAuthorization(
      { ...env, OAUTH_PROVIDER: helpers },
      new Request(flow.url),
    );
    const expiresAt = Date.now() + 30 * 24 * 3600_000;
    const approved = await helpers.completeAuthorization({
      request: auth,
      userId: session.sub,
      scope: ["iterate"],
      revokeExistingGrants: false,
      metadata: { clientName: data.name, tokenKind: "personal" },
      props: {
        kind: "user-grant",
        version: 1,
        userId: session.sub,
        email: session.email,
        projects,
        tokenKind: "personal",
        deadline: expiresAt,
      } satisfies GrantProps,
    });
    const code = new URL(approved.redirectTo).searchParams.get("code");
    if (!code) throw new Error("The token authorization did not produce a code.");
    const response = await exchangeToken(
      new Request(`${issuer}/oauth/token`, {
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
    return { token: tokens.access_token, expiresAt };
  }
}
