import { z } from "zod";
import { fakeAuthorizationServer, redirectTo, tokenClient } from "./authorization-server.ts";
import type { ShopDeps } from "./state.ts";

type Grant = { id: string; username: string; scope: string };

/** X-shaped OAuth: PKCE + HTTP Basic, no ID token, and rotating refresh tokens.
 * https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code */
export async function handleXRequest(request: Request, deps: ShopDeps): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/2/") && url.pathname !== "/i/oauth2/authorize") return null;
  const x = fakeAuthorizationServer<Grant>(deps, "x", (grant) => grant.id);
  const error = (message: string, status = 400) => Response.json({ error: message }, { status });
  if (request.method === "GET" && url.pathname === "/i/oauth2/authorize") {
    const query = Object.fromEntries(url.searchParams);
    const refused = await x.authorizeRefusal(query.client_id || "", query.redirect_uri || "");
    if (refused) return refused;
    if (!query.code_challenge || query.code_challenge_method !== "S256")
      return error("PKCE required");
    const code = await x.code({
      clientId: query.client_id!,
      redirectUri: query.redirect_uri!,
      codeChallenge: query.code_challenge,
      grant: {
        id: query.user || "12345",
        username: query.username || "prototype",
        scope: query.scope || "",
      },
    });
    return redirectTo(query.redirect_uri!, { code, state: query.state });
  }
  if (request.method === "POST" && url.pathname === "/2/oauth2/token") {
    const form = Object.fromEntries(new URLSearchParams(await request.text()));
    const client = await tokenClient(deps, request, form);
    if (
      !client ||
      (!client.client.public && !request.headers.get("authorization")?.startsWith("Basic "))
    )
      return error("invalid_client", 401);
    let grant: Grant;
    if (form.grant_type === "authorization_code") {
      const redeemed = await x.redeemCode(form.code || "", {
        ...client,
        redirectUri: form.redirect_uri,
        codeVerifier: form.code_verifier,
      });
      if ("refused" in redeemed) return error("invalid_grant");
      grant = redeemed.grant;
    } else if (form.grant_type === "refresh_token") {
      const refresh = await x.openRefreshToken(form.refresh_token || "", client.clientId);
      if (!refresh) return error("invalid_grant");
      grant = refresh.grant;
      await x.revokeRefreshToken(form.refresh_token!);
    } else return error("unsupported_grant_type");
    return Response.json({
      token_type: "bearer",
      scope: grant.scope,
      expires_in: client.client.accessTokenTtlSeconds,
      access_token: await x.accessToken(
        client.clientId,
        grant,
        client.client.accessTokenTtlSeconds,
      ),
      ...(grant.scope.split(" ").includes("offline.access") && {
        refresh_token: await x.refreshToken(client.clientId, grant),
      }),
    });
  }
  const token = await x.openAccessToken(
    request.headers.get("authorization")?.replace(/^Bearer /, "") || "",
  );
  if (!token) return error("unauthorized", 401);
  if (request.method === "GET" && url.pathname === "/2/users/me")
    return Response.json({ data: { id: token.grant.id, username: token.grant.username } });
  // Stable fixtures let the bot tests distinguish a verified author from an impersonator.
  if (request.method === "GET" && /^\/2\/tweets\/\d+$/.test(url.pathname)) {
    const id = url.pathname.split("/").at(-1)!;
    return Response.json({
      data: {
        id,
        text: "@iteratebot hello",
        author_id: id === "112" ? "67890" : "12345",
        entities: { mentions: [{ username: "iteratebot" }] },
      },
    });
  }
  if (request.method === "POST" && url.pathname === "/2/tweets") {
    if (!token.grant.scope.split(" ").includes("tweet.write"))
      return error("insufficient_scope", 403);
    if (token.grant.id === "101") return error("write_outcome_unknown", 503);
    const body = z
      .object({ text: z.string(), reply: z.object({ in_reply_to_tweet_id: z.string() }) })
      .parse(await request.json());
    if (body.text === "reject this fixture") return error("invalid_reply", 400);
    return Response.json({ data: { id: "99999", text: body.text } }, { status: 201 });
  }
  return new Response("Not Found", { status: 404 });
}
