// Real issuer login, consent and code exchange. Only identity proof is an admin fixture.
// eslint-disable-next-line iterate/no-capnweb-http-batch -- Bounded fixture calls; the returned public client uses WebSocket.
import { newHttpBatchRpcSession } from "capnweb";
import { authorizationCodeRequest } from "../../src/client/oauth.ts";
import type { SessionRpcTarget } from "../../src/session.ts";
import { adminCredentials, publicSession, workerUrl } from "./client.ts";

export async function oauthSession(project: string, user: { email: string }) {
  const issuer = new URL(workerUrl("/")).origin;
  const login = await fetch(workerUrl("/login"), {
    method: "POST",
    headers: { Authorization: `Bearer ${adminCredentials().secret}` },
    body: new URLSearchParams({ email: user.email, next: "/" }),
    redirect: "manual",
  });
  if (login.status !== 302)
    throw new Error(`Identity fixture: ${login.status} ${await login.text()}`);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  await login.body?.cancel();
  const headers = { Origin: issuer, Cookie: cookie };
  const clientId = "https://claude.ai/oauth/claude-code-client-metadata";
  const redirectUri = "http://127.0.0.1/callback";
  const flow = await authorizationCodeRequest({
    issuer,
    clientId,
    redirectUri,
    resources: [workerUrl("/api")],
  });
  // eslint-disable-next-line iterate/no-capnweb-http-batch -- The same consent capability the browser calls, with an issuer session.
  using issuerApi = newHttpBatchRpcSession<SessionRpcTarget>(new Request(workerUrl("/api"), { headers }));
  const approved = await issuerApi.consent.approve({ query: flow.url.search, projects: [project] });
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
