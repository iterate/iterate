import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { SignJWT, importJWK, type JWK } from "jose";
import {
  ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM,
  ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM,
  ITERATE_IS_ADMIN_CLAIM,
  ITERATE_ROLE_CLAIM,
} from "@iterate-com/shared/auth-claims";

// Mint an OS session for any identity — dev and preview environments.
//
// OS trusts JWTs signed by any key in its baked JWKS. In dev/preview that
// JWKS includes the *forge* public key whose private half lives in the
// Doppler config (`AUTH_FORGE_PRIVATE_JWK`, inherited from `_shared/dev` /
// `_shared/preview`). This script signs an access+id token pair with that key
// — fully offline, no auth worker involved — so agents and tests can be any
// user instantly. There is deliberately no forge key in prd: minting against
// production goes through the (audited) auth worker instead.
//
//   # local dev (uses the running dev server's discovery file for the URL)
//   doppler run --project os --config dev -- pnpm auth:mint --email alice+test@nustom.com
//
//   # admin identity, print a one-shot browser sign-in URL only
//   doppler run --project os --config dev -- pnpm auth:mint --admin --browser-url
//
//   # against a preview slot
//   doppler run --project os --config preview_3 -- pnpm auth:mint --email e2e+test@nustom.com
//
// The minted tokens work three ways:
//   1. `Authorization: Bearer <accessToken>` against the OS API
//   2. browserSignInUrl — navigate any browser (Playwright/agent-browser) to
//      it once; it sets the normal session cookie and redirects
//   3. as a cookie session via /api/iterate-auth/session-from-token directly

const { values: args } = parseArgs({
  options: {
    email: { type: "string", default: "agent+test@nustom.com" },
    sub: { type: "string" },
    name: { type: "string" },
    admin: { type: "boolean", default: false },
    ttl: { type: "string", default: "3600" },
    orgs: { type: "string" },
    projects: { type: "string" },
    claims: { type: "string" },
    "base-url": { type: "string" },
    "browser-url": { type: "boolean", default: false },
    "return-to": { type: "string", default: "/" },
    help: { type: "boolean", default: false },
  },
});

if (args.help) {
  console.log(
    [
      "Usage: doppler run --project os --config <dev|preview_N> -- pnpm auth:mint [options]",
      "",
      "  --email <email>      identity email (default agent+test@nustom.com)",
      "  --sub <id>           subject id (default derived from email)",
      "  --name <name>        display name",
      "  --admin              mint a platform-admin identity",
      "  --ttl <seconds>      token lifetime (default 3600)",
      "  --orgs <json>        org claims: [{id,slug,name,role}]",
      "  --projects <json>    project claims: [{id,slug,organizationId}]",
      "  --claims <json>      extra access-token claims to merge",
      "  --base-url <url>     OS base URL (default: env APP_CONFIG_BASE_URL,",
      "                       else apps/os/.alchemy/dev-server.json)",
      "  --browser-url        print only the one-shot browser sign-in URL",
      "  --return-to <path>   where the browser URL redirects after sign-in",
    ].join("\n"),
  );
  process.exit(0);
}

function findRepoRoot(start: string) {
  let dir = start;
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

function resolveBaseUrl(): string {
  if (args["base-url"]) return args["base-url"].replace(/\/+$/, "");
  const fromEnv = process.env.APP_CONFIG_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  const repoRoot = findRepoRoot(process.cwd());
  const discovery = join(repoRoot, "apps/os/.alchemy/dev-server.json");
  if (existsSync(discovery)) {
    const info = JSON.parse(readFileSync(discovery, "utf8")) as { baseUrl?: string; pid?: number };
    if (info.baseUrl) return info.baseUrl.replace(/\/+$/, "");
  }
  throw new Error(
    "Could not resolve the OS base URL: pass --base-url, set APP_CONFIG_BASE_URL, " +
      "or start the local dev server (apps/os/.alchemy/dev-server.json).",
  );
}

const forgePrivateJwkJson = process.env.AUTH_FORGE_PRIVATE_JWK?.trim();
if (!forgePrivateJwkJson) {
  throw new Error(
    "AUTH_FORGE_PRIVATE_JWK is not in the environment. Run under a dev/preview Doppler config " +
      "(e.g. `doppler run --project os --config dev -- pnpm auth:mint ...`). " +
      "There is intentionally no forge key for prd — production minting goes through the auth worker.",
  );
}

const issuer = (
  process.env.APP_CONFIG_ITERATE_AUTH__ISSUER ?? process.env.ITERATE_OAUTH_ISSUER
)?.trim();
const clientId = (
  process.env.APP_CONFIG_ITERATE_AUTH__CLIENT_ID ?? process.env.ITERATE_OAUTH_CLIENT_ID
)?.trim();
if (!issuer || !clientId) {
  throw new Error(
    "APP_CONFIG_ITERATE_AUTH__ISSUER and APP_CONFIG_ITERATE_AUTH__CLIENT_ID are required in the environment.",
  );
}

const baseUrl = resolveBaseUrl();
const baseUrlHostname = new URL(baseUrl).hostname;
const baseIsLoopback =
  baseUrlHostname === "localhost" ||
  baseUrlHostname.endsWith(".localhost") ||
  baseUrlHostname === "127.0.0.1";
// Must match what the OS worker advertises as its OAuth resource: the stable
// portless loopback origin locally, the deployed base URL otherwise.
const resource =
  process.env.APP_CONFIG_ITERATE_AUTH__RESOURCE?.trim() ??
  (baseIsLoopback ? `http://${baseUrlHostname}` : baseUrl);

const forgeJwk = JSON.parse(forgePrivateJwkJson) as JWK & { kid?: string; alg?: string };
const alg = forgeJwk.alg ?? "EdDSA";
const key = await importJWK(forgeJwk, alg);

const email = args.email!;
const sub = args.sub ?? `usr_forged_${email.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
const name = args.name ?? email.split("@")[0]!;
const ttlSeconds = Number(args.ttl);
const now = Math.floor(Date.now() / 1000);
const sid = `ses_forged_${Math.random().toString(36).slice(2, 10)}`;

const orgs = args.orgs ? (JSON.parse(args.orgs) as unknown[]) : [];
const projects = args.projects ? (JSON.parse(args.projects) as unknown[]) : [];
const extraClaims = args.claims ? (JSON.parse(args.claims) as Record<string, unknown>) : {};

const protectedHeader = { alg, kid: forgeJwk.kid } as const;

const accessToken = await new SignJWT({
  email,
  scope: "openid profile email",
  scopes: ["openid", "profile", "email"],
  sid,
  [ITERATE_IS_ADMIN_CLAIM]: args.admin,
  [ITERATE_ROLE_CLAIM]: args.admin ? "admin" : null,
  [ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM]: orgs,
  [ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM]: projects,
  ...extraClaims,
})
  .setProtectedHeader(protectedHeader)
  .setSubject(sub)
  .setIssuer(issuer)
  .setAudience(resource)
  .setIssuedAt(now)
  .setExpirationTime(now + ttlSeconds)
  .sign(key);

const idToken = await new SignJWT({
  email,
  name,
  email_verified: true,
  [ITERATE_IS_ADMIN_CLAIM]: args.admin,
  [ITERATE_ROLE_CLAIM]: args.admin ? "admin" : null,
})
  .setProtectedHeader(protectedHeader)
  .setSubject(sub)
  .setIssuer(issuer)
  .setAudience(clientId)
  .setIssuedAt(now)
  .setExpirationTime(now + ttlSeconds)
  .sign(key);

const browserSignInUrl = `${baseUrl}/api/iterate-auth/session-from-token?${new URLSearchParams({
  access_token: accessToken,
  id_token: idToken,
  return_to: args["return-to"]!,
}).toString()}`;

if (args["browser-url"]) {
  console.log(browserSignInUrl);
} else {
  console.log(
    JSON.stringify(
      {
        sub,
        email,
        admin: args.admin,
        baseUrl,
        resource,
        expiresAt: new Date((now + ttlSeconds) * 1000).toISOString(),
        accessToken,
        idToken,
        browserSignInUrl,
      },
      null,
      2,
    ),
  );
}
