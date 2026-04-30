import { createPublicKey, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

type ClerkApplication = {
  application_id: string;
  name: string;
  instances: ClerkInstance[];
};

type ClerkInstance = {
  instance_id: string;
  environment_type: string;
  publishable_key: string;
  secret_key?: string;
};

type ClerkOAuthApplication = {
  id: string;
  name: string;
  client_id: string;
};

const mcpOAuthScopes = ["openid", "email", "profile"];
const mcpOAuthApplicationPatch = {
  name: "OS2 MCP / CLI",
  public: true,
  pkce_required: true,
  consent_screen_enabled: true,
  scopes: [...mcpOAuthScopes, "offline_access"].join(" "),
  redirect_uris: ["http://127.0.0.1/*"],
};

type Target = {
  dopplerConfig: string;
  clerkAppName: string;
  baseUrl: string;
  eventsBaseUrl: string;
  projectHostnameBase: string;
};

const targets: Target[] = [
  {
    dopplerConfig: "dev_jonas",
    clerkAppName: "OS2 dev jonas",
    baseUrl: "https://os.iterate-dev-jonas.com",
    eventsBaseUrl: "https://events.iterate-dev-jonas.com",
    projectHostnameBase: "iterate-dev-jonas.app",
  },
  {
    dopplerConfig: "dev_misha",
    clerkAppName: "OS2 dev misha",
    baseUrl: "https://os.iterate-dev-misha.com",
    eventsBaseUrl: "https://events.iterate-dev-misha.com",
    projectHostnameBase: "iterate-dev-misha.app",
  },
  {
    dopplerConfig: "dev_rahul",
    clerkAppName: "OS2 dev rahul",
    baseUrl: "https://os.iterate-dev-rahul.com",
    eventsBaseUrl: "https://events.iterate-dev-rahul.com",
    projectHostnameBase: "iterate-dev-rahul.app",
  },
  ...Array.from({ length: 10 }, (_, index) => {
    const previewNumber = index + 1;
    return {
      dopplerConfig: `preview_${previewNumber}`,
      clerkAppName: `OS2 preview ${previewNumber}`,
      baseUrl: `https://os-preview-${previewNumber}.iterate.app`,
      eventsBaseUrl: `https://events-preview-${previewNumber}.iterate.com`,
      projectHostnameBase: `-preview-${previewNumber}.iterate.app`,
    };
  }),
  {
    dopplerConfig: "prd",
    clerkAppName: "OS2 prd",
    baseUrl: "https://os.iterate2.com",
    eventsBaseUrl: "https://events.iterate.com",
    projectHostnameBase: "iterate2.app",
  },
];

async function main() {
  const apps = listClerkApps();

  for (const target of targets) {
    const app = findOrCreateClerkApp(apps, target.clerkAppName);
    const instance = getDevelopmentInstance(app.application_id);

    patchInstanceConfig(app.application_id);
    patchOAuthApplicationSettings(app.application_id);
    const oauthApplication = findOrCreateOAuthApplication(app.application_id);
    const jwtKey = await getJwtPublicKey(instance.publishable_key);

    setDopplerSecrets(target, instance, oauthApplication, jwtKey);
    console.log(`synced ${target.dopplerConfig} -> ${target.clerkAppName}`);
  }
}

function listClerkApps() {
  return JSON.parse(exec("clerk", ["apps", "list", "--json"])) as ClerkApplication[];
}

function findOrCreateClerkApp(apps: ClerkApplication[], name: string) {
  const existing = apps.find((app) => app.name === name);
  if (existing) return existing;

  const created = JSON.parse(exec("clerk", ["apps", "create", name, "--json"])) as ClerkApplication;
  apps.push(created);
  return created;
}

function getDevelopmentInstance(applicationId: string) {
  const app = JSON.parse(
    exec("clerk", [
      "api",
      `/platform/applications/${applicationId}?include_secret_keys=true`,
      "--platform",
    ]),
  ) as ClerkApplication;

  const instance = app.instances.find((entry) => entry.environment_type === "development");
  if (!instance?.secret_key) {
    throw new Error(`No development instance secret key found for ${app.name}`);
  }

  return instance;
}

function patchInstanceConfig(applicationId: string) {
  const patch = {
    auth_email: {
      required_for_sign_up: true,
      sign_in_strategies: ["email_code"],
      used_for_sign_in: true,
      used_for_sign_up: true,
      verification_strategies: ["email_code"],
      verify_at_sign_up: true,
    },
    connection_oauth_google: {
      authenticatable: true,
      block_email_subaddresses: true,
      enabled: true,
      show_account_selector_prompt: false,
    },
    organization_settings: {
      admin_delete_enabled: true,
      creator_role: "org:admin",
      domains_enabled: false,
      domains_enrollment_modes: [],
      enabled: true,
      force_organization_selection: true,
      organization_creation_defaults: {
        automatic_organization_creation: { enabled: false },
        detect_from_email_domain: { enabled: true },
        enabled: true,
        fallback: { name: "My Organization" },
        organization_name_template: {
          enabled: true,
          template: "{{user.first_name}}'s Organization",
        },
      },
      slug_disabled: true,
    },
  };

  exec("clerk", [
    "config",
    "patch",
    "--app",
    applicationId,
    "--instance",
    "dev",
    "--json",
    JSON.stringify(patch),
    "--yes",
  ]);
}

function patchOAuthApplicationSettings(applicationId: string) {
  exec("clerk", [
    "api",
    "/instance/oauth_application_settings",
    "--app",
    applicationId,
    "--instance",
    "dev",
    "--method",
    "PATCH",
    "--data",
    JSON.stringify({
      dynamic_oauth_client_registration: true,
      oauth_jwt_access_tokens: true,
    }),
    "--yes",
  ]);
}

function findOrCreateOAuthApplication(applicationId: string) {
  const existing = JSON.parse(
    exec("clerk", ["api", "/oauth_applications", "--app", applicationId, "--instance", "dev"]),
  ) as { data: ClerkOAuthApplication[] };

  const match = existing.data.find((app) => app.name === "OS2 MCP / CLI");
  if (match) {
    return JSON.parse(
      exec("clerk", [
        "api",
        `/oauth_applications/${match.id}`,
        "--app",
        applicationId,
        "--instance",
        "dev",
        "--method",
        "PATCH",
        "--data",
        JSON.stringify(mcpOAuthApplicationPatch),
        "--yes",
      ]),
    ) as ClerkOAuthApplication;
  }

  return JSON.parse(
    exec("clerk", [
      "api",
      "/oauth_applications",
      "--app",
      applicationId,
      "--instance",
      "dev",
      "--data",
      JSON.stringify(mcpOAuthApplicationPatch),
      "--yes",
    ]),
  ) as ClerkOAuthApplication;
}

async function getJwtPublicKey(publishableKey: string) {
  const frontendApiUrl = deriveFrontendApiUrl(publishableKey);
  const jwks = (await fetch(`${frontendApiUrl}/.well-known/jwks.json`).then((response) =>
    response.json(),
  )) as { keys: JsonWebKey[] };
  const signingKey = jwks.keys.find((key) => key.use === "sig") ?? jwks.keys[0];
  if (!signingKey) {
    throw new Error(`No JWT signing key found at ${frontendApiUrl}`);
  }

  return createPublicKey({ key: signingKey, format: "jwk" }).export({
    type: "spki",
    format: "pem",
  });
}

function deriveFrontendApiUrl(publishableKey: string) {
  const encoded = publishableKey.replace(/^pk_(?:test|live)_/, "");
  return `https://${Buffer.from(encoded, "base64").toString("utf8").replace(/\$/, "")}`;
}

function setDopplerSecrets(
  target: Target,
  instance: ClerkInstance,
  oauthApplication: ClerkOAuthApplication,
  jwtKey: string | Buffer,
) {
  const secrets = new Map([
    ["APP_CONFIG_BASE_URL", target.baseUrl],
    // Codemode streams are written through the Events app. Keep this aligned
    // per Doppler config so dev and preview OS2 sessions do not write into
    // production event streams.
    ["APP_CONFIG_EVENTS_BASE_URL", target.eventsBaseUrl],
    [
      "APP_CONFIG_MCP_PROOF_SECRET",
      readExistingDopplerSecret(target.dopplerConfig, "APP_CONFIG_MCP_PROOF_SECRET") ??
        randomBytes(32).toString("base64url"),
    ],
    ["APP_CONFIG_PROJECT_HOSTNAME_BASES", JSON.stringify([target.projectHostnameBase])],
    ["APP_CONFIG_CLERK__PUBLISHABLE_KEY", instance.publishable_key],
    ["APP_CONFIG_CLERK__SECRET_KEY", instance.secret_key!],
    ["APP_CONFIG_CLERK__JWT_KEY", jwtKey.toString()],
    ["APP_CONFIG_CLERK__OAUTH_CLIENT_ID", oauthApplication.client_id],
    ["APP_CONFIG_CLERK__MCP_OAUTH_SCOPES", JSON.stringify(mcpOAuthScopes)],
  ]);

  for (const [key, value] of secrets) {
    const result = spawnSync(
      "doppler",
      [
        "secrets",
        "set",
        key,
        "--project",
        "os2",
        "--config",
        target.dopplerConfig,
        "--no-interactive",
      ],
      {
        input: value,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    if (result.status !== 0) {
      throw new Error(
        `Failed to set ${key} for ${target.dopplerConfig}: ${result.stderr || result.stdout}`,
      );
    }
  }
}

function readExistingDopplerSecret(config: string, key: string) {
  const result = spawnSync(
    "doppler",
    [
      "run",
      "--project",
      "os2",
      "--config",
      config,
      "--",
      "node",
      "-e",
      `process.stdout.write(process.env[${JSON.stringify(key)}] || "")`,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (result.status !== 0) {
    return null;
  }

  return result.stdout.trim() || null;
}

function exec(command: string, args: string[]) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

await main();
