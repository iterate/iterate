import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

// One-time/idempotent provisioning of per-slot auth preview configs.
//
// Each preview slot N gets its own auth deployment (auth.iterate-preview-N.com)
// for a completely clean, controlled e2e slate. Doppler is the source of truth
// for the slot's OS↔auth OAuth client credentials: this script writes constants
// into `auth/preview_N` (consumed by the auth deploy's seed step, which
// enforces Doppler → DB) and mirrors them into `os/preview_N` so both apps can
// deploy concurrently with nothing minted at deploy time.
//
// Idempotent: existing credentials are kept (pass --rotate to regenerate).
// Run with a Doppler token that can write both projects:
//
//   pnpm tsx scripts/preview/provision-auth-preview-configs.ts

const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const rotate = process.argv.includes("--rotate");

function doppler(args: string[], input?: string) {
  return execFileSync("doppler", args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function getSecret(project: string, config: string, name: string): string | null {
  try {
    return doppler(["secrets", "get", name, "--project", project, "--config", config, "--plain"]);
  } catch {
    return null;
  }
}

function setSecrets(project: string, config: string, secrets: Record<string, string>) {
  const args = ["secrets", "set", "--project", project, "--config", config, "--silent"];
  for (const [key, value] of Object.entries(secrets)) {
    args.push(`${key}=${value}`);
  }
  doppler(args);
}

function ensureConfig(project: string, config: string) {
  const existing = doppler(["configs", "--project", project, "--json"]);
  const names = (JSON.parse(existing) as { name: string }[]).map((c) => c.name);
  if (!names.includes(config)) {
    doppler(["configs", "create", config, "--project", project]);
    console.log(`created config ${project}/${config}`);
  }
}

function freshSecret() {
  return randomBytes(32).toString("hex");
}

// --- auth root `preview` config: values shared by every slot --------------
// (CF creds / ALCHEMY_* arrive via Config Inheritance from _shared/preview.)
const sharedFromDev = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "RESEND_BOT_DOMAIN",
  "RESEND_BOT_API_KEY",
  "SIGNUP_ALLOWLIST",
];
const rootValues: Record<string, string> = {
  VITE_ENABLE_EMAIL_OTP_SIGNIN: "true",
};
for (const name of sharedFromDev) {
  if (getSecret("auth", "preview", name)) continue;
  const value = getSecret("auth", "dev", name);
  if (!value) throw new Error(`auth/dev is missing ${name}`);
  rootValues[name] = value;
}
setSecrets("auth", "preview", rootValues);
console.log("auth/preview root config ensured");

// --- per-slot branch configs ----------------------------------------------
for (const slot of SLOTS) {
  const config = `preview_${slot}`;
  const authOrigin = `https://auth.iterate-preview-${slot}.com`;
  const osOrigin = `https://os.iterate-preview-${slot}.com`;
  const clientId = `os-preview-${slot}`;

  ensureConfig("auth", config);

  const existingSeed = rotate ? null : getSecret("auth", config, "AUTH_SEED_OAUTH_CLIENTS");
  const existingSecret = existingSeed
    ? (JSON.parse(existingSeed) as { clientSecret: string }[])[0]?.clientSecret
    : null;
  const clientSecret = existingSecret ?? freshSecret();

  const existingServiceToken = rotate ? null : getSecret("auth", config, "SERVICE_AUTH_TOKEN");
  const serviceToken = existingServiceToken ?? freshSecret();
  const existingBetterAuthSecret = rotate ? null : getSecret("auth", config, "BETTER_AUTH_SECRET");
  const betterAuthSecret = existingBetterAuthSecret ?? freshSecret();

  const seed = JSON.stringify([
    {
      clientId,
      clientSecret,
      clientName: `OS preview ${slot} web`,
      redirectURIs: [`${osOrigin}/api/iterate-auth/callback`],
      referenceId: `os:${config}:web`,
      skipConsent: true,
    },
  ]);

  setSecrets("auth", config, {
    VITE_AUTH_APP_ORIGIN: authOrigin,
    // preview.ts reads APP_CONFIG_BASE_URL to learn the app's public URL.
    APP_CONFIG_BASE_URL: authOrigin,
    WORKER_ROUTES: `auth.iterate-preview-${slot}.com`,
    BETTER_AUTH_SECRET: betterAuthSecret,
    SERVICE_AUTH_TOKEN: serviceToken,
    AUTH_SEED_OAUTH_CLIENTS: seed,
  });

  setSecrets("os", config, {
    APP_CONFIG_ITERATE_AUTH__ISSUER: `${authOrigin}/api/auth`,
    APP_CONFIG_ITERATE_AUTH__CLIENT_ID: clientId,
    APP_CONFIG_ITERATE_AUTH__CLIENT_SECRET: clientSecret,
    APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN: serviceToken,
  });

  console.log(`slot ${slot}: auth/${config} + os/${config} ensured (client ${clientId})`);
}

console.log("done");
