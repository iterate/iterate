import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BrowserContext } from "@playwright/test";
import {
  ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM,
  ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM,
  ITERATE_IS_ADMIN_CLAIM,
  ITERATE_ROLE_CLAIM,
  type IterateAuthAccessTokenOrganizationClaim,
  type IterateAuthProjectClaim,
} from "@iterate-com/shared/auth-claims";
import { withItx } from "../../apps/os/src/itx/client.ts";

const execFileAsync = promisify(execFile);

type DopplerAuthEnv = {
  APP_CONFIG_ADMIN_API_SECRET?: string;
  APP_CONFIG_ITERATE_AUTH__CLIENT_ID?: string;
  APP_CONFIG_ITERATE_AUTH__ISSUER?: string;
  APP_CONFIG_ITERATE_AUTH__RESOURCE?: string;
  AUTH_FORGE_PRIVATE_JWK?: string;
  ITERATE_OAUTH_CLIENT_ID?: string;
  ITERATE_OAUTH_ISSUER?: string;
};

type ForgePrivateJwk = JsonWebKey & {
  alg?: string;
  kid?: string;
};

type OsPlaywrightAuthConfig = {
  adminApiSecret: string;
  clientId: string;
  forgePrivateJwk: ForgePrivateJwk;
  issuer: string;
  resource: string;
};

export type MintedIterateSession = {
  accessToken: string;
  expiresAtMs: number;
  idToken: string;
};

let configPromise: Promise<OsPlaywrightAuthConfig> | undefined;
let signingKeyPromise: Promise<CryptoKey> | undefined;

export async function createAdminProject(input: { baseUrl: string; slug: string }) {
  const config = await resolveOsPlaywrightAuthConfig(input.baseUrl);
  using itx = withItx({ baseUrl: input.baseUrl, token: config.adminApiSecret });
  const project = (await itx.projects.create({ slug: input.slug })) as {
    id: string;
    slug: string;
  };
  let disposed = false;

  return {
    project,
    async [Symbol.asyncDispose]() {
      if (disposed) return;
      disposed = true;
      using cleanupItx = withItx({ baseUrl: input.baseUrl, token: config.adminApiSecret });
      await cleanupItx.projects.remove({ id: project.id }).catch(() => undefined);
    },
  };
}

export async function mintIterateSession(input: {
  baseUrl: string;
  email: string;
  organizations: IterateAuthAccessTokenOrganizationClaim[];
  projects: IterateAuthProjectClaim[];
}) {
  const config = await resolveOsPlaywrightAuthConfig(input.baseUrl);
  const subject = `usr_forged_${input.email.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
  const now = Math.floor(Date.now() / 1000);
  const ttlSeconds = 60 * 60;
  const expiresAtSeconds = now + ttlSeconds;
  const sessionId = `ses_forged_${crypto.randomUUID().slice(0, 8)}`;

  const accessToken = await signJwt({
    audience: config.resource,
    issuer: config.issuer,
    payload: {
      email: input.email,
      scope: "openid profile email",
      scopes: ["openid", "profile", "email"],
      sid: sessionId,
      [ITERATE_IS_ADMIN_CLAIM]: false,
      [ITERATE_ROLE_CLAIM]: null,
      [ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM]: input.organizations,
      [ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM]: input.projects,
    },
    subject,
    now,
    expiresAtSeconds,
    privateJwk: config.forgePrivateJwk,
  });
  const idToken = await signJwt({
    audience: config.clientId,
    issuer: config.issuer,
    payload: {
      email: input.email,
      email_verified: true,
      name: input.email.split("@")[0] || input.email,
      [ITERATE_IS_ADMIN_CLAIM]: false,
      [ITERATE_ROLE_CLAIM]: null,
    },
    subject,
    now,
    expiresAtSeconds,
    privateJwk: config.forgePrivateJwk,
  });

  return {
    accessToken,
    expiresAtMs: expiresAtSeconds * 1000,
    idToken,
  };
}

export async function addIterateSessionCookie(input: {
  baseUrl: string;
  context: BrowserContext;
  session: MintedIterateSession;
}) {
  await input.context.addCookies([
    {
      expires: Math.floor(input.session.expiresAtMs / 1000),
      httpOnly: true,
      name: "iterate_session",
      sameSite: "Lax",
      secure: new URL(input.baseUrl).protocol === "https:",
      url: input.baseUrl,
      value: encodeURIComponent(
        JSON.stringify({
          accessToken: input.session.accessToken,
          accessTokenExpiresAt: input.session.expiresAtMs,
          idToken: input.session.idToken,
          tokenType: "bearer",
        }),
      ),
    },
  ]);
}

async function resolveOsPlaywrightAuthConfig(baseUrl: string): Promise<OsPlaywrightAuthConfig> {
  configPromise = configPromise || loadOsPlaywrightAuthConfig(baseUrl);
  return await configPromise;
}

async function loadOsPlaywrightAuthConfig(baseUrl: string): Promise<OsPlaywrightAuthConfig> {
  const dopplerEnv = await readDopplerAuthEnv();
  const authorizeConfig = await readOsAuthAuthorizeConfig(baseUrl);
  const issuer =
    process.env.OS_PLAYWRIGHT_AUTH_ISSUER ||
    authorizeConfig.issuer ||
    process.env.APP_CONFIG_ITERATE_AUTH__ISSUER ||
    process.env.ITERATE_OAUTH_ISSUER ||
    dopplerEnv.APP_CONFIG_ITERATE_AUTH__ISSUER ||
    dopplerEnv.ITERATE_OAUTH_ISSUER ||
    "";
  const clientId =
    authorizeConfig.clientId ||
    process.env.APP_CONFIG_ITERATE_AUTH__CLIENT_ID ||
    process.env.ITERATE_OAUTH_CLIENT_ID ||
    dopplerEnv.APP_CONFIG_ITERATE_AUTH__CLIENT_ID ||
    dopplerEnv.ITERATE_OAUTH_CLIENT_ID ||
    "";
  const resource =
    process.env.OS_PLAYWRIGHT_AUTH_RESOURCE ||
    authorizeConfig.resource ||
    process.env.APP_CONFIG_ITERATE_AUTH__RESOURCE ||
    dopplerEnv.APP_CONFIG_ITERATE_AUTH__RESOURCE ||
    defaultAuthResource(baseUrl);
  const adminApiSecret =
    process.env.OS_E2E_ADMIN_API_SECRET ||
    process.env.OS_ADMIN_API_SECRET ||
    process.env.APP_CONFIG_ADMIN_API_SECRET ||
    dopplerEnv.APP_CONFIG_ADMIN_API_SECRET ||
    "";
  const forgePrivateJwkJson =
    process.env.AUTH_FORGE_PRIVATE_JWK || dopplerEnv.AUTH_FORGE_PRIVATE_JWK || "";

  if (!issuer) throw new Error("Missing Iterate auth issuer for Playwright forged session.");
  if (!clientId) throw new Error("Missing Iterate auth client id for Playwright forged session.");
  if (!resource) throw new Error("Missing Iterate auth resource for Playwright forged session.");
  if (!adminApiSecret) {
    throw new Error("Missing OS admin API secret for Playwright admin project setup.");
  }
  if (!forgePrivateJwkJson) {
    throw new Error("Missing AUTH_FORGE_PRIVATE_JWK for Playwright forged session.");
  }

  const forgePrivateJwk = JSON.parse(forgePrivateJwkJson) as ForgePrivateJwk;
  if (forgePrivateJwk.kty !== "OKP" || forgePrivateJwk.crv !== "Ed25519") {
    throw new Error("Playwright forged sessions currently require an Ed25519 forge JWK.");
  }
  if (!forgePrivateJwk.kid) {
    throw new Error("AUTH_FORGE_PRIVATE_JWK must include a kid.");
  }

  return {
    adminApiSecret,
    clientId,
    forgePrivateJwk,
    issuer,
    resource,
  };
}

async function readDopplerAuthEnv(): Promise<DopplerAuthEnv> {
  const direct: DopplerAuthEnv = {
    APP_CONFIG_ADMIN_API_SECRET: process.env.APP_CONFIG_ADMIN_API_SECRET,
    APP_CONFIG_ITERATE_AUTH__CLIENT_ID: process.env.APP_CONFIG_ITERATE_AUTH__CLIENT_ID,
    APP_CONFIG_ITERATE_AUTH__ISSUER: process.env.APP_CONFIG_ITERATE_AUTH__ISSUER,
    APP_CONFIG_ITERATE_AUTH__RESOURCE: process.env.APP_CONFIG_ITERATE_AUTH__RESOURCE,
    AUTH_FORGE_PRIVATE_JWK: process.env.AUTH_FORGE_PRIVATE_JWK,
    ITERATE_OAUTH_CLIENT_ID: process.env.ITERATE_OAUTH_CLIENT_ID,
    ITERATE_OAUTH_ISSUER: process.env.ITERATE_OAUTH_ISSUER,
  };
  if (
    direct.APP_CONFIG_ADMIN_API_SECRET &&
    direct.AUTH_FORGE_PRIVATE_JWK &&
    (direct.APP_CONFIG_ITERATE_AUTH__CLIENT_ID || direct.ITERATE_OAUTH_CLIENT_ID)
  ) {
    return direct;
  }

  const config = process.env.OS_PLAYWRIGHT_DOPPLER_CONFIG || process.env.DOPPLER_CONFIG || "dev";
  const script = `
const keys = [
  "APP_CONFIG_ADMIN_API_SECRET",
  "APP_CONFIG_ITERATE_AUTH__CLIENT_ID",
  "APP_CONFIG_ITERATE_AUTH__ISSUER",
  "APP_CONFIG_ITERATE_AUTH__RESOURCE",
  "AUTH_FORGE_PRIVATE_JWK",
  "ITERATE_OAUTH_CLIENT_ID",
  "ITERATE_OAUTH_ISSUER"
];
process.stdout.write(JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key] || ""]))));
`;

  const { stdout } = await execFileAsync(
    "doppler",
    ["run", "--project", "os", "--config", config, "--", "node", "-e", script],
    { maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout) as DopplerAuthEnv;
}

async function signJwt(input: {
  audience: string;
  expiresAtSeconds: number;
  issuer: string;
  now: number;
  payload: Record<string, unknown>;
  privateJwk: ForgePrivateJwk;
  subject: string;
}) {
  const header = base64UrlEncode(
    JSON.stringify({
      alg: "EdDSA",
      kid: input.privateJwk.kid,
      typ: "JWT",
    }),
  );
  const payload = base64UrlEncode(
    JSON.stringify({
      ...input.payload,
      aud: input.audience,
      exp: input.expiresAtSeconds,
      iat: input.now,
      iss: input.issuer,
      sub: input.subject,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    await signingKey(input.privateJwk),
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

async function signingKey(privateJwk: ForgePrivateJwk) {
  signingKeyPromise =
    signingKeyPromise ||
    crypto.subtle.importKey("jwk", privateJwk, { name: "Ed25519" }, false, ["sign"]);
  return await signingKeyPromise;
}

function defaultAuthResource(baseUrl: string) {
  const url = new URL(baseUrl);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname.endsWith(".localhost");
  return loopback ? `http://${url.hostname}` : baseUrl.replace(/\/+$/, "");
}

async function readOsAuthAuthorizeConfig(baseUrl: string) {
  let url = new URL("/api/iterate-auth/login?return_to=/", baseUrl);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, { redirect: "manual" });
    const location = response.headers.get("location");
    if (!location) break;

    const nextUrl = new URL(location, url);
    if (nextUrl.origin === new URL(baseUrl).origin && nextUrl.pathname === url.pathname) {
      url = nextUrl;
      continue;
    }

    const issuerPath = nextUrl.pathname.replace(/\/oauth2\/authorize$/u, "");
    return {
      clientId: nextUrl.searchParams.get("client_id") || "",
      issuer: `${nextUrl.origin}${issuerPath}`,
      resource: nextUrl.searchParams.get("resource") || "",
    };
  }

  return {
    clientId: "",
    issuer: "",
    resource: "",
  };
}

function base64UrlEncode(value: string | ArrayBuffer) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  return Buffer.from(bytes).toString("base64url");
}
