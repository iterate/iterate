import { parseArgs } from "node:util";
import { createAuthContractClient } from "@iterate-com/auth-contract";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    "organization-name": { type: "string" },
    "organization-slug": { type: "string" },
    "project-slug": { type: "string" },
  },
});

const email = required(values.email, "--email");
const organizationName = required(values["organization-name"], "--organization-name");
const organizationSlug = required(values["organization-slug"], "--organization-slug");
const projectSlug = required(values["project-slug"], "--project-slug");

const authBaseUrl = resolveLocalAuthBaseUrl();
const serviceToken =
  process.env.APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN ||
  process.env.ITERATE_AUTH_SERVICE_TOKEN ||
  process.env.SERVICE_AUTH_TOKEN;
if (!serviceToken) {
  throw new Error(
    "A local auth service token is required. Run through Doppler so SERVICE_AUTH_TOKEN or ITERATE_AUTH_SERVICE_TOKEN is available.",
  );
}

const client = createAuthContractClient({ baseUrl: authBaseUrl, serviceToken });
const seeded = await retry(async () => {
  const user = await client.internal.user.upsertVerifiedEmail({
    email,
    image: null,
    name: email.split("@")[0] || email,
  });
  const organization = await client.internal.organization.createForUser({
    name: organizationName,
    slug: organizationSlug,
    userId: user.id,
  });
  const project = await client.internal.project.createForOrganization({
    name: projectSlug,
    organizationSlug: organization.slug,
    slug: projectSlug,
  });

  return { email, organization, project, user };
});

console.log(JSON.stringify(seeded));

function required(value: string | undefined, flag: string) {
  if (value) return value;
  throw new Error(`${flag} is required`);
}

function resolveLocalAuthBaseUrl() {
  const issuer = (
    process.env.APP_CONFIG_ITERATE_AUTH__ISSUER ||
    process.env.ITERATE_OAUTH_ISSUER ||
    "http://localhost:7101/api/auth"
  ).trim();
  const origin = new URL(issuer).origin;
  const hostname = new URL(origin).hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return origin;
  }
  throw new Error(`OS Playwright auth seed is local-only; refusing auth origin ${origin}`);
}

async function retry<T>(fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 120_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw lastError;
}
