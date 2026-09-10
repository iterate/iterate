import { z } from "zod";
import type { GrantSummary } from "@cloudflare/workers-oauth-provider";
import type { ConsoleRequestContext } from "./control-plane.ts";
import { requireBrowserSession } from "./browser-client.ts";
import { codedError, errorCode } from "./lib.ts";
import { directory } from "./directory.ts";
import {
  authorizationCodeRequest,
  exchangeToken,
  oauthAddresses,
  oauthHelpers,
  parseAuthorization,
  revokeGrant,
  type GrantProps,
} from "./oauth.ts";

const DisplayMetadata = z.object({
  clientName: z.string().optional(),
  tokenKind: z.string().optional(),
  expiresAt: z.number().optional(),
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

/** Provider pagination is the inventory; D1 adds use and revocation state only. */
export async function listGrants(context: ConsoleRequestContext, cursor?: string) {
  const { env, request, ctx } = context;
  const session = await requireBrowserSession(env, request, ctx);
  const page = await oauthHelpers(env).listUserGrants(session.sub, { limit: 50, cursor });
  const activity = await env.DB.prepare(`SELECT grant_id, last_used_at, revoked_at, cleanup_pending
FROM oauth_activity WHERE user_id = ? AND (grant_id IN (${page.items.map(() => "?").join(",") || "NULL"}) OR cleanup_pending = 1)`)
    .bind(session.sub, ...page.items.map((grant) => grant.id))
    .all<Activity>();
  const records = new Map(activity.results.map((row) => [row.grant_id, row]));
  const items = page.items.flatMap((grant) => {
    const row = records.get(grant.id);
    records.delete(grant.id);
    if (row?.revoked_at && !row.cleanup_pending) return [];
    const metadata = DisplayMetadata.parse(grant.metadata ?? {});
    const expiresAt = metadata.expiresAt ?? (grant.expiresAt ? grant.expiresAt * 1000 : null);
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
export async function endGrant(context: ConsoleRequestContext, grantId: string) {
  const { env, request, ctx } = context;
  const session = await requireBrowserSession(env, request, ctx);
  const marker = await env.DB.prepare(
    "SELECT revoked_at FROM oauth_activity WHERE user_id = ? AND grant_id = ?",
  )
    .bind(session.sub, grantId)
    .first<{ revoked_at: number | null }>();
  if (!marker?.revoked_at) {
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
export async function mintPersonalToken(context: ConsoleRequestContext, input: unknown) {
  const { env, request, ctx } = context;
  const session = await requireBrowserSession(env, request, ctx);
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
  const auth = await parseAuthorization({ ...env, OAUTH_PROVIDER: helpers }, new Request(flow.url));
  const expiresAt = Date.now() + 30 * 24 * 3600_000;
  const approved = await helpers.completeAuthorization({
    request: auth,
    userId: session.sub,
    scope: ["iterate"],
    revokeExistingGrants: false,
    metadata: { clientName: data.name, tokenKind: "personal", expiresAt },
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
      refresh_token: z.undefined(),
    })
    .parse(await response.json());
  return { token: tokens.access_token, expiresAt };
}

/** Plain forms and automated clients use the same actions as the Start page. */
export async function grantsDoor(context: ConsoleRequestContext) {
  const { request } = context;
  const path = new URL(request.url).pathname;
  if (request.method !== "POST" || !["/sessions/revoke", "/sessions/token"].includes(path))
    return null;
  try {
    const form = await request.formData();
    if (path === "/sessions/revoke") {
      await endGrant(context, String(form.get("grantId") ?? ""));
      return new Response(null, { status: 303, headers: { Location: "/sessions" } });
    }
    return Response.json(
      await mintPersonalToken(context, {
        name: String(form.get("name") ?? ""),
        projects: form.getAll("project").map(String),
      }),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const code = errorCode(error);
    if (
      !(error instanceof z.ZodError) &&
      !["UNAUTHENTICATED", "GRANT_NOT_FOUND", "FORBIDDEN"].includes(code ?? "")
    )
      throw error;
    const status =
      code === "UNAUTHENTICATED"
        ? 401
        : code === "GRANT_NOT_FOUND"
          ? 404
          : code === "FORBIDDEN"
            ? 403
            : 400;
    return new Response(error instanceof Error ? error.message : String(error), {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
