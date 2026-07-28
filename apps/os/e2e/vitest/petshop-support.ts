// Helpers for the dummy-petshop integration proof (S5). The e2e runs in Node
// and talks to TWO deployed services:
//   - the OS deployment (APP_CONFIG_BASE_URL) over itx, as the project backend;
//   - the deployed dummy-petshop (the fake third party) over plain HTTP, both
//     as an OAuth provider/API and through its /__backdoor test console.
// The OS Secret DO fetches petshop directly; nothing here proxies for it.

/** The seeded petshop OAuth client every deployment starts with (state.ts). */
export const PETSHOP_DEFAULT_CLIENT = {
  clientId: "petshop-default",
  clientSecret: "petshop-default-secret",
} as const;

/**
 * Local e2e can opt out when the fixture was not started. CI may not: the
 * preview orchestrator must pass the deployed sibling's exact URL, and a
 * missing value is an orchestration failure rather than permission to turn
 * these integration tests into silent skips.
 */
export function shouldSkipPetshopE2e(): boolean {
  if (process.env.PETSHOP_BASE_URL?.trim()) return false;
  if (process.env.CI === "true") {
    throw new Error(
      "CI must provide PETSHOP_BASE_URL for the deployed preview Petshop; refusing to skip OS Petshop e2e.",
    );
  }
  return true;
}

/** The exact deployed Petshop selected by the preview orchestrator. */
export function petshopBaseUrl(): string {
  const explicit = process.env.PETSHOP_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  throw new Error("petshop e2e needs the deployed fixture's exact PETSHOP_BASE_URL");
}

function backdoorHeaders(): Record<string, string> {
  const secret = process.env.PETSHOP_BACKDOOR_SECRET?.trim();
  return secret ? { "x-petshop-backdoor": secret } : {};
}

async function petshopJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${petshopBaseUrl()}${path}`, init);
  if (!response.ok) {
    throw new Error(`petshop ${path} -> ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/** Register a fresh OAuth client (the second instance's credentials for the
 * two-client proof). */
export function petshopMintClient(): Promise<{ clientId: string; clientSecret: string }> {
  return petshopJson("/__backdoor/clients", {
    method: "POST",
    headers: { "content-type": "application/json", ...backdoorHeaders() },
    body: "{}",
  });
}

/** Bump one token client's epoch—the deterministic way to force its real
 * 401 → refresh without invalidating credentials used by concurrent tests. */
export function petshopExpireTokens(
  clientId: string,
): Promise<{ clientId: string; accessTokenEpoch: number }> {
  return petshopJson("/__backdoor/expire-tokens", {
    method: "POST",
    headers: { "content-type": "application/json", ...backdoorHeaders() },
    body: JSON.stringify({ clientId }),
  });
}

// petshop's webhook backdoors (/__backdoor/rotate-signing-secret,
// /__backdoor/webhooks/fire) are exercised again when the userspace-lane PR
// lands its webhook-verification story; helpers for them return with it.

/** Walk the OAuth authorize step in the consent-free test lane (`approve=1`)
 * and return the authorization code from the redirect. */
export async function petshopAuthorize(input: {
  clientId: string;
  redirectUri: string;
}): Promise<string> {
  const url = new URL(`${petshopBaseUrl()}/oauth/authorize`);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", "e2e");
  url.searchParams.set("approve", "1");
  const response = await fetch(url, { redirect: "manual" });
  const location = response.headers.get("location");
  if (!location) throw new Error(`petshop authorize did not redirect (${response.status})`);
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error(`petshop authorize redirect had no code: ${location}`);
  return code;
}

/** Exchange an authorization code for tokens, acting as the project backend
 * (the trusted party that holds the client secret at connect time). Uses HTTP
 * Basic client auth — the same form the OS refresh worker rides via a header
 * placeholder. */
export async function petshopExchangeCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const basic = Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64");
  const response = await fetch(`${petshopBaseUrl()}/oauth/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code: input.code,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    }).toString(),
  });
  if (!response.ok) throw new Error(`petshop token exchange -> ${response.status}`);
  return (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
}

/**
 * Register (or replace) a GitHub-App installation's RS256 PUBLIC key on petshop
 * — the only key petshop ever holds. The OS side keeps the private half in the
 * connection secret's material and the Secret DO's github-app-installation
 * strategy signs App JWTs with it in trusted DO code; petshop verifies those
 * JWTs against this public key when minting an installation token. `appId` is
 * the JWT issuer petshop enforces.
 */
export function petshopRegisterApp(input: {
  appId: string;
  installationId: string;
  publicKeyPem: string;
}): Promise<{ appId: string; installationId: string; webhookSecret: string }> {
  return petshopJson("/__backdoor/apps", {
    method: "POST",
    headers: { "content-type": "application/json", ...backdoorHeaders() },
    body: JSON.stringify(input),
  });
}

// The WebSocket gateway-relay proof (the three credential shapes against
// petshop's /gateway* endpoints) is deferred with the secret-worker/jail lane:
// it returns in the userspace-integrations PR, where jailed workers (and WS
// egress through the Secret DO's fetch) are reintroduced. Petshop keeps its
// gateway endpoints so that proof needs no fixture changes when it lands.
