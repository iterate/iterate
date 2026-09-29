/**
 * A ChatGPT-shaped fake: OpenAI's Sign in with ChatGPT for open-source tools
 * (https://developers.openai.com/siwc/token-sharing-open-source), at auth.openai.com's and
 * api.openai.com's own paths:
 *
 *   GET  /api/accounts/authorize     consent at once for `dynamic_agent_client`, which registers a
 *                                    public client `oaiapp_…` for the consent (or for a client it
 *                                    registered before): redirects to the loopback redirect_uri
 *                                    with code, the granted scope, state and client_id=<issued>;
 *                                    `&email=` and `&user=` (its `sub`) pick the account
 *   POST /api/accounts/oauth/token   authorization_code | refresh_token (rotating) of the issued
 *                                    client, by client_id alone; an unsigned ID token names the
 *                                    account. The code exchange needs `resource`, as OpenAI's does:
 *                                    without it the code is spent and `invalid_grant` answered
 *   POST /v1/responses               the Responses API behind the access token: `stream: true`,
 *                                    `store: false` and a list `input` required; streams "pong"
 *
 * The OAuth steps are the fakes' one authorization server (authorization-server.ts).
 */
import { fakeAuthorizationServer, redirectTo, tokenClient } from "./authorization-server.ts";
import { base64Url, nowSeconds } from "./seal.ts";
import type { ShopDeps } from "./state.ts";

interface ChatgptGrant {
  sub: string;
  email: string;
  scope: string;
  /** The OpenID nonce to echo in the ID token. */
  nonce?: string;
}

/** ChatGPT's paths on this origin, or null when the request is not one of them. */
export async function handleChatgptRequest(
  request: Request,
  deps: ShopDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/accounts/") && !url.pathname.startsWith("/v1/")) return null;
  const chatgpt = fakeAuthorizationServer<ChatgptGrant>(deps, "chatgpt", (grant) => grant.email);
  const error = (message: string, status = 400) => Response.json({ error: message }, { status });
  const detail = (message: string, status = 400) => Response.json({ detail: message }, { status });
  if (request.method === "GET" && url.pathname === "/api/accounts/authorize") {
    const query = Object.fromEntries(url.searchParams);
    if (!query.code_challenge || query.code_challenge_method !== "S256")
      return error("PKCE required");
    const redirectUri = query.redirect_uri || "";
    const loopback = URL.canParse(redirectUri) ? new URL(redirectUri) : null;
    if (loopback?.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(loopback.hostname))
      return error("redirect_uri must be a loopback address");
    // every consent begins as `dynamic_agent_client`, which registers the client it issues
    const clientId =
      query.client_id === "dynamic_agent_client"
        ? (
            await deps.state.createClient({
              public: true,
              redirectUris: [redirectUri],
              idPrefix: "oaiapp_",
            })
          ).clientId
        : query.client_id || "";
    if (!clientId.startsWith("oaiapp_")) return error("unknown client_id");
    const refused = await chatgpt.authorizeRefusal(clientId, redirectUri);
    if (refused) return refused;
    const grant = {
      sub: query.user || "user-12345",
      email: query.email || "prototype@petshop.test",
      scope: query.scope || "openid profile email offline_access",
      nonce: query.nonce,
    };
    const code = await chatgpt.code({
      clientId,
      redirectUri,
      codeChallenge: query.code_challenge,
      grant,
    });
    return redirectTo(redirectUri, {
      code,
      scope: grant.scope,
      state: query.state,
      client_id: clientId,
    });
  }
  if (request.method === "POST" && url.pathname === "/api/accounts/oauth/token") {
    const form = Object.fromEntries(new URLSearchParams(await request.text()));
    const client = await tokenClient(deps, request, form);
    if (!client?.client.public) return error("invalid_client", 401);
    let grant: ChatgptGrant;
    if (form.grant_type === "authorization_code") {
      const redeemed = await chatgpt.redeemCode(form.code || "", {
        ...client,
        redirectUri: form.redirect_uri,
        codeVerifier: form.code_verifier,
      });
      if ("refused" in redeemed || form.resource !== "https://api.openai.com/v1")
        return error("invalid_grant");
      grant = redeemed.grant;
    } else if (form.grant_type === "refresh_token") {
      const refresh = await chatgpt.openRefreshToken(form.refresh_token || "", client.clientId);
      if (!refresh) return error("invalid_grant");
      // a refresh answers no ID token's nonce
      grant = { ...refresh.grant, nonce: undefined };
      await chatgpt.revokeRefreshToken(form.refresh_token!);
    } else return error("unsupported_grant_type");
    const ttlSeconds = client.client.accessTokenTtlSeconds;
    const now = nowSeconds();
    const encode = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));
    return Response.json({
      access_token: await chatgpt.accessToken(client.clientId, grant, ttlSeconds),
      ...(grant.scope.split(" ").includes("offline_access") && {
        refresh_token: await chatgpt.refreshToken(client.clientId, grant),
      }),
      // an unsecured JWT (RFC 7519 §6): the platform reads the claims of an ID token straight
      // from the token endpoint without checking a signature
      id_token: `${encode({ alg: "none", typ: "JWT" })}.${encode({
        iss: url.origin,
        aud: [client.clientId],
        sub: grant.sub,
        email: grant.email,
        iat: now,
        exp: now + 3600,
        nonce: grant.nonce,
      })}.`,
      scope: grant.scope,
      token_type: "Bearer",
      expires_in: ttlSeconds,
    });
  }
  if (request.method === "POST" && url.pathname === "/v1/responses") {
    const token = await chatgpt.openAccessToken(
      request.headers.get("authorization")?.replace(/^Bearer /, "") || "",
    );
    if (!token) return detail("Unauthorized", 401);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (body?.stream !== true) return detail("Stream must be set to true");
    if (body.store !== false) return detail("Store must be set to false");
    if (!Array.isArray(body.input)) return detail("Input must be a list");
    const response = {
      id: `resp_${crypto.randomUUID().replaceAll("-", "")}`,
      object: "response",
      created_at: nowSeconds(),
      model: body.model,
      output: [] as unknown[],
    };
    const item = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
    const events = [
      { type: "response.created", response: { ...response, status: "in_progress" } },
      ...["po", "ng"].map((delta) => ({
        type: "response.output_text.delta",
        item_id: item,
        output_index: 0,
        content_index: 0,
        delta,
      })),
      {
        type: "response.completed",
        response: {
          ...response,
          status: "completed",
          output: [
            {
              id: item,
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "pong", annotations: [] }],
            },
          ],
          usage: {
            input_tokens: body.input.length,
            output_tokens: 1,
            total_tokens: body.input.length + 1,
          },
        },
      },
    ];
    return new Response(
      events
        .map(
          (event, sequence_number) =>
            `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
        )
        .join(""),
      { headers: { "content-type": "text/event-stream; charset=utf-8" } },
    );
  }
  return new Response("Not Found", { status: 404 });
}
