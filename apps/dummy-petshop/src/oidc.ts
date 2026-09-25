/**
 * What the Google and Cloudflare fakes share to act as OpenID Connect
 * providers: the discovery document, the JWKS, and RS256 ID tokens signed with
 * the shop's one key (state.ts `oidcSigningKey`), so a relying party verifies
 * them exactly as it verifies Google's or Cloudflare's.
 */
import { nowSeconds } from "./seal.ts";
import type { IntegrationFakeDeps } from "./state.ts";

/** The discovery document for an issuer whose endpoints hang under it (`<issuer>/<path>`). */
export function discoveryDocument(
  issuer: string,
  paths: { authorization: string; token: string; jwks: string; userinfo?: string },
) {
  return {
    issuer,
    authorization_endpoint: `${issuer}${paths.authorization}`,
    token_endpoint: `${issuer}${paths.token}`,
    jwks_uri: `${issuer}${paths.jwks}`,
    ...(paths.userinfo && { userinfo_endpoint: `${issuer}${paths.userinfo}` }),
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
  };
}

export async function jwks(deps: IntegrationFakeDeps) {
  const key = await deps.state.oidcSigningKey();
  return { keys: [{ ...key.publicJwk, kid: key.kid, alg: "RS256", use: "sig" }] };
}

/** An ID token for `claims`, from `issuer` to `clientId`, valid for ten minutes. */
export async function signIdToken(
  deps: IntegrationFakeDeps,
  input: { issuer: string; clientId: string; claims: Record<string, unknown> },
): Promise<string> {
  const key = await deps.state.oidcSigningKey();
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    key.privateJwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const now = nowSeconds();
  const encode = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));
  const signingInput = `${encode({ alg: "RS256", kid: key.kid, typ: "JWT" })}.${encode({
    iss: input.issuer,
    aud: input.clientId,
    iat: now,
    exp: now + 600,
    ...input.claims,
  })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

/** The client a token request authenticates as: HTTP Basic, or `client_id` and `client_secret` in
 *  the form (both are what Google and Cloudflare accept). */
export function tokenRequestClient(
  request: Request,
  form: Record<string, string>,
): { clientId: string; clientSecret: string | undefined } {
  const basic = /^Basic\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (basic) {
    const [clientId = "", clientSecret] = atob(basic).split(":");
    return { clientId, clientSecret };
  }
  return { clientId: form.client_id || "", clientSecret: form.client_secret };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** THE FAKES' ACCOUNT PICKER — what a real provider's sign-in page is for: a form asking which
 *  account (`fields`: `email`, and GitHub's `login`), submitted back to the same authorize URL
 *  with the rest of its query kept. A fake shows it when the request names no account and asks for
 *  a pick (`prompt=select_account`, or Cloudflare's login page); a test that names one skips it. */
export function accountPicker(url: URL, fields: readonly ("email" | "login")[]): Response {
  const escape = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  const hidden = [...url.searchParams]
    .filter(([key]) => !fields.includes(key as "email" | "login"))
    .map(([key, value]) => `<input type="hidden" name="${escape(key)}" value="${escape(value)}">`)
    .join("");
  const inputs = fields
    .map(
      (field) =>
        `<label>${field === "email" ? "Email" : "Username"} <input name="${field}" required${field === "email" ? ' type="email"' : ""}></label>`,
    )
    .join("<br>");
  return new Response(
    `<!doctype html><title>Choose an account</title><h1>Choose an account</h1><form method="get" action="${escape(url.pathname)}">${hidden}${inputs}<br><button type="submit">Continue</button></form>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
