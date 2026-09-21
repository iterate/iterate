// Real issuer login, consent and code exchange. The identity proof is the sign-in page's own password
// step (`POST /login` with the email and the deployment's password — the same post the page makes).
// eslint-disable-next-line iterate/no-capnweb-http-batch -- Bounded fixture calls; the returned public client uses WebSocket.
import { newHttpBatchRpcSession } from "capnweb";
import { authorizationCodeRequest } from "iterate/next/oauth";
import type { IterateRpcTarget } from "../../src/session.ts";
import { loginPassword, publicSession, workerUrl } from "./client.ts";

/** THE ISSUER SESSION for `email`: the sign-in page's password post, as the page itself makes it
 *  (same-origin, a form) — the `Cookie` header value a browser would then carry. */
export async function issuerCookie(email: string, next = "/"): Promise<string> {
  const issuer = new URL(workerUrl("/")).origin;
  const login = await fetch(workerUrl("/login"), {
    method: "POST",
    headers: { Origin: issuer },
    body: new URLSearchParams({ email, password: loginPassword(), next }),
    redirect: "manual",
  });
  if (login.status !== 302)
    throw new Error(`Sign-in fixture: ${login.status} ${await login.text()}`);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  await login.body?.cancel();
  return cookie;
}

/** A real OAuth grant for `user`, consented to the one project `projectId` (consent ticks projects
 *  by their minted id, as the console does): the public session, its token, the principal it
 *  stamps, and the issuer cookie the account itself speaks with. */
export async function oauthSession(projectId: string, user: { email: string }) {
  const issuer = new URL(workerUrl("/")).origin;
  const headers = { Origin: issuer, Cookie: await issuerCookie(user.email) };
  const clientId = "https://claude.ai/oauth/claude-code-client-metadata";
  const redirectUri = "http://127.0.0.1/callback";
  const flow = await authorizationCodeRequest({
    issuer,
    clientId,
    redirectUri,
    resources: [workerUrl("/api")],
  });
  // eslint-disable-next-line iterate/no-capnweb-http-batch -- The same consent capability the browser calls, with an issuer session.
  using issuerApi = newHttpBatchRpcSession<IterateRpcTarget>(
    new Request(workerUrl("/api"), { headers }),
  );
  const approved = await issuerApi
    .authenticate({ type: "from-server-cookie" })
    .consent.approve({ query: flow.url.search, projects: [projectId] });
  if (!("redirectTo" in approved)) throw new Error(JSON.stringify(approved));
  const callback = new URL(approved.redirectTo);
  if (callback.searchParams.get("state") !== flow.state) throw new Error("OAuth state changed");
  const exchange = await fetch(workerUrl("/oauth/token"), {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code: callback.searchParams.get("code")!,
      code_verifier: flow.verifier,
      resource: workerUrl("/api"),
    }),
  });
  if (!exchange.ok) throw new Error(`Token exchange: ${exchange.status} ${await exchange.text()}`);
  const { access_token: token } = (await exchange.json()) as { access_token: string };
  const api = publicSession(token);
  const principal = await api.whoami();
  return { api, token, principal, issuerHeaders: headers };
}
