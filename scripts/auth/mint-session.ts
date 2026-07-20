import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readDevServerInfo } from "../../apps/os/scripts/lib/dev-server-info.ts";
import { forgedSubjectForEmail, mintForgedAccessToken, mintForgedIdToken } from "./forge-token.ts";

// Mint an OS session for any identity — dev, preview, and production.
//
// Auth and every relying party use one environment signing key whose private
// half lives in Doppler (`AUTH_FORGE_PRIVATE_JWK`, from `_shared/dev` /
// `_shared/preview` and the prd app configs). This script signs an access+id
// token pair with that key — fully offline, no auth worker involved — so you
// can be any user instantly. The key is a master key; in prod it is gated
// behind AUTH_FORGE_ALLOW_PRODUCTION in every deploy that consumes it. An audited
// mint endpoint on the auth worker is the planned replacement for prod.
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
//   # against production (mints a real os.iterate.com session — handle with care)
//   doppler run --project os --config prd -- pnpm auth:mint --email someone@nustom.com --browser-url
//
// The minted tokens work three ways:
//   1. `Authorization: Bearer <accessToken>` against the OS API
//   2. browserSignInUrl — navigate any browser (Playwright/agent-browser) to
//      it once; it sets the normal session cookie and redirects
//   3. as a cookie session via /api/iterate-auth/session-from-token directly
//
// LIMITATION — claims are FROZEN at mint time. Minted sessions carry no
// refresh token, and the auth worker rejects forge-signed tokens at its
// userinfo/token endpoints (the forge key is not in its JWKS), so the session
// can never re-mint claims. Anything created after mint (organizations,
// projects) stays invisible to the session — e.g. a project created through
// the UI never appears in the minted session's project list — until a real
// sign-in. `/session?refresh=force` flags this with the
// `x-iterate-auth-stale-refresh` header and a browser-console warning.

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
      "                       else apps/os/.dev-server/dev-server.json)",
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
  // requireLive: a stale discovery file (crash, kill -9) would hand back a
  // browser URL that points nowhere.
  const info = readDevServerInfo(join(repoRoot, "apps/os"), { requireLive: true });
  if (info) return info.baseUrl.replace(/\/+$/, "");
  throw new Error(
    "Could not resolve the OS base URL: pass --base-url, set APP_CONFIG_BASE_URL, " +
      "or start the local dev server (apps/os/.dev-server/dev-server.json).",
  );
}

const forgePrivateJwkJson = process.env.AUTH_FORGE_PRIVATE_JWK?.trim();
if (!forgePrivateJwkJson) {
  throw new Error(
    "AUTH_FORGE_PRIVATE_JWK is not in the environment. Run under a Doppler config that carries " +
      "the forge key — dev, preview, or prd (e.g. `doppler run --project os --config dev -- pnpm auth:mint ...`). " +
      "Prod additionally requires AUTH_FORGE_ALLOW_PRODUCTION=true in each consuming app's deploy config.",
  );
}

const issuer = process.env.APP_CONFIG_ITERATE_AUTH__ISSUER?.trim();
const clientId = process.env.APP_CONFIG_ITERATE_AUTH__CLIENT_ID?.trim();
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

const email = args.email!;
const sub = args.sub ?? forgedSubjectForEmail(email);
const name = args.name ?? email.split("@")[0]!;
const ttlSeconds = Number(args.ttl);
const now = Math.floor(Date.now() / 1000);

const orgs = args.orgs ? (JSON.parse(args.orgs) as unknown[]) : [];
const projects = args.projects ? (JSON.parse(args.projects) as unknown[]) : [];
const extraClaims = args.claims ? (JSON.parse(args.claims) as Record<string, unknown>) : {};

const accessToken = await mintForgedAccessToken({
  forgePrivateJwk: forgePrivateJwkJson,
  issuer,
  audience: resource,
  email,
  sub,
  admin: args.admin,
  ttlSeconds,
  organizations: orgs,
  projects,
  claims: extraClaims,
});

const idToken = await mintForgedIdToken({
  forgePrivateJwk: forgePrivateJwkJson,
  issuer,
  clientId,
  email,
  sub,
  name,
  admin: args.admin,
  ttlSeconds,
});

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
