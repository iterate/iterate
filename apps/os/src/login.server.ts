// The sign-in page's server side: what /login shows for this browser, and what its plain form posts
// do. The route (routes/login.tsx) renders the first and hands POST /login to the second.

import { errorCode, sameOriginPath } from "iterate/next/lib";
import { startIssuerSession } from "./issuer-session.ts";
import {
  clearLoginCookie,
  finishLoginCode,
  loginCodePending,
  signInWithPassword,
  startLoginCode,
} from "./password-and-code-sign-in.ts";
import { appConfigOf, platformAddressesOf } from "./app-config.ts";
import { browserAuthorization } from "./browser-client.ts";
import type { UserRecord } from "./control-plane/catalog.ts";
import type { Env } from "./env.ts";

/** The sign-in page's data for this request: who is signed in, or which ways to sign in exist. */
export async function loginState(request: Request, env: Env, ctx: ExecutionContext) {
  const config = appConfigOf(env);
  const url = new URL(request.url);
  const next = sameOriginPath(
    url.searchParams.get("next") || "/login",
    platformAddressesOf(env, request).platformOrigin,
  );
  const session = await browserAuthorization(env, request, ctx);
  return {
    next,
    signedInAs: session ? session.principal.email || session.principal.actor : null,
    switchAccount: `/.auth/logout?next=${encodeURIComponent(`/login?next=${encodeURIComponent(next)}`)}`,
    codeSentTo: session ? null : await loginCodePending(env, request),
    error: url.searchParams.get("error"),
    // the email the refused post carried, so the page keeps what was typed
    email: url.searchParams.get("email") || "",
    password: Boolean(config.login.password.exposeSecret()),
    passwordSelected: url.searchParams.get("method") === "password",
    // The code form needs both its configuration and the mailbox binding.
    emailSignIn: Boolean(env.EMAIL && config.login.emailCode),
    google: config.login.google ? `/.auth/identity?next=${encodeURIComponent(next)}` : null,
    cloudflare: config.login.cloudflare
      ? `/.auth/identity/cloudflare?next=${encodeURIComponent(next)}`
      : null,
    // where a signed-in person with nowhere else to go is sent (the landing page's pointer)
    dash: config.urls.dash || null,
  };
}

/** The sign-in page's POSTs — plain forms, no script in the loop. `method` switches between the
 *  code and the password form, keeping the email typed; an `email` with a `password` signs in at
 *  once; an `email` alone starts the code sign-in; a `code` finishes it; `restart` drops a pending
 *  code for another email. What goes wrong comes back to the page as `?error=` (303), so the person
 *  reads it where they typed. */
export async function loginFormResponse(request: Request, env: Env): Promise<Response> {
  const form = await request.formData().catch(() => null);
  if (!form) return new Response("Expected a form", { status: 400 });
  const next = String(form.get("next") || "/login");
  const email = String(form.get("email") ?? "").trim();
  const method = form.get("method");
  /** Back to the page with what went wrong — and the email as typed, so it is still there. */
  const back = (error?: string, ...cookies: string[]) => {
    const query = new URLSearchParams({ next });
    if (error) query.set("error", error);
    if ((error || method) && email) query.set("email", email);
    if (method === "password" || (error && form.has("password"))) query.set("method", "password");
    const headers = new Headers({ location: `/login?${query}` });
    for (const cookie of cookies) headers.append("set-cookie", cookie);
    return new Response(null, { status: 303, headers });
  };
  /** The person is signed in: the issuer session's cookie, any pending code dropped, onward. */
  const signedIn = async (user: UserRecord) => {
    const { setCookie, location } = await startIssuerSession(env, request, user, next);
    const headers = new Headers({ location });
    headers.append("set-cookie", setCookie);
    headers.append("set-cookie", clearLoginCookie);
    return new Response(null, { status: 302, headers });
  };
  try {
    if (method) return back();
    if (form.has("restart")) return back(undefined, clearLoginCookie);
    if (form.has("code")) {
      const finished = await finishLoginCode(env, request, String(form.get("code") ?? ""));
      if ("error" in finished)
        return finished.restart ? back(finished.error, clearLoginCookie) : back(finished.error);
      return signedIn(finished.user);
    }
    const client = request.headers.get("cf-connecting-ip");
    if (form.has("password")) {
      const attempt = await signInWithPassword(env, email, String(form.get("password")), client);
      if ("error" in attempt) return back(attempt.error);
      return signedIn(attempt.user);
    }
    const started = await startLoginCode(env, email, client);
    return back(undefined, started.setCookie);
  } catch (error) {
    const code = errorCode(error);
    if (code === "INVALID_INPUT")
      return back(error instanceof Error ? error.message : "Try again.");
    if (code !== "UNAUTHENTICATED") throw error;
    return new Response(error instanceof Error ? error.message : String(error), { status: 401 });
  }
}
