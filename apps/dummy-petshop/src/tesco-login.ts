/**
 * The Tesco-shaped two-step login: a web form guarded by a CSRF token bound to
 * a cookie, the shape a grocer's website signs in with. One more way into the
 * ONE pets API, alongside OAuth, the legacy JSON login and the GraphQL
 * session login. The OS side has no named strategy for it: a secret logs in
 * here through exchange code of its own (`refresh: { kind: "worker", source }`).
 *
 * - `GET /api/tesco/login` → `{ csrf }` and a `Set-Cookie: tesco_login=<sealed>`
 *   that binds that token; both live {@link TESCO_LOGIN_FORM_TTL_SECONDS}s.
 * - `POST /api/tesco/login`, form `email`, `password`, `_csrf`, with that cookie
 *   → `{ access_token, expires_in: 900 }`. Any email, password "correct-horse".
 *   No cookie, or a `_csrf` the cookie does not bind, is a 403; a wrong
 *   password a 401.
 * - The access token is an ordinary sealed access token of the client
 *   `tesco-login:<email>`, so `/__backdoor/expire-tokens` with that client id
 *   revokes one account's tokens: what a test that forces a 401 wants, since
 *   this ONE shop serves every concurrent CI run.
 */
import { nowSeconds, seal, unseal } from "./seal.ts";

/** How long a Tesco-minted access token lives. */
export const TESCO_ACCESS_TTL_SECONDS = 900;

/** How long the form's CSRF token and its cookie live. */
const TESCO_LOGIN_FORM_TTL_SECONDS = 600;

/** The fixture login password (any email works), as the other logins. */
export const TESCO_LOGIN_PASSWORD = "correct-horse";

/** The cookie that binds the form's CSRF token. */
const TESCO_LOGIN_COOKIE = "tesco_login";

/** The client id an account's Tesco-minted tokens belong to — its revocation key. */
export const tescoLoginClientId = (email: string) => `tesco-login:${email}`;

/** What the endpoint needs from the shop: the sealing key and the revocation epoch of a client. */
export interface TescoLoginDeps {
  sealKey: string;
  accessTokenEpoch(clientId: string): Promise<number>;
}

/** The sealed cookie: the CSRF token it binds and when it stops. */
interface TescoLoginCookie {
  t: "tesco-login-form";
  csrf: string;
  exp: number;
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** `GET` or `POST /api/tesco/login`; null for anything else. */
export async function handleTescoLogin(
  request: Request,
  deps: TescoLoginDeps,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/tesco/login") return null;
  if (request.method === "GET") return loginForm(deps);
  if (request.method === "POST") return login(request, deps);
  return null;
}

async function loginForm(deps: TescoLoginDeps): Promise<Response> {
  const csrf = crypto.randomUUID();
  const cookie: TescoLoginCookie = {
    t: "tesco-login-form",
    csrf,
    exp: nowSeconds() + TESCO_LOGIN_FORM_TTL_SECONDS,
  };
  return json({ csrf }, 200, {
    "set-cookie": `${TESCO_LOGIN_COOKIE}=${await seal(cookie, deps.sealKey)}; Path=/api/tesco; HttpOnly; Secure; SameSite=Lax; Max-Age=${TESCO_LOGIN_FORM_TTL_SECONDS}`,
  });
}

async function login(request: Request, deps: TescoLoginDeps): Promise<Response> {
  const form = await request.formData().catch(() => new FormData());
  const sealed = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${TESCO_LOGIN_COOKIE}=`))
    ?.slice(TESCO_LOGIN_COOKIE.length + 1);
  const cookie = sealed ? await unseal<TescoLoginCookie>(sealed, deps.sealKey) : null;
  if (
    cookie?.t !== "tesco-login-form" ||
    cookie.exp < nowSeconds() ||
    form.get("_csrf") !== cookie.csrf
  )
    return json({ error: "invalid_csrf", error_description: "GET /api/tesco/login first" }, 403);
  const email = String(form.get("email") ?? "");
  if (!email || form.get("password") !== TESCO_LOGIN_PASSWORD)
    return json({ error: "invalid_credentials" }, 401);
  const clientId = tescoLoginClientId(email);
  // The pets API's ordinary access token (worker.ts `accessGrant`), bound to this account's epoch.
  const accessToken = await seal(
    {
      t: "access",
      sub: email,
      clientId,
      epoch: await deps.accessTokenEpoch(clientId),
      exp: nowSeconds() + TESCO_ACCESS_TTL_SECONDS,
    },
    deps.sealKey,
  );
  return json({ access_token: accessToken, expires_in: TESCO_ACCESS_TTL_SECONDS });
}
