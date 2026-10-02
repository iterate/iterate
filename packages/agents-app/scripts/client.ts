import { connectIterate } from "iterate/node";

/** One connection to WORKER_BASE_URL, authenticated as the CLI authenticates (core/lib/src/cli): with
 *  APP_CONFIG_SECRETS__ADMIN_BEARER, the deployment's operator bearer, for a project no token at
 *  hand covers, else with ITERATE_BEARER_TOKEN, the person's personal access token for the project
 *  (core/os/docs/credentials.md). Dispose it to close its socket. */
export async function connect() {
  const baseUrl = process.env.WORKER_BASE_URL;
  if (!baseUrl) throw new Error("WORKER_BASE_URL is required");
  const secret = process.env.APP_CONFIG_SECRETS__ADMIN_BEARER?.trim();
  if (secret) return await connectIterate({ baseUrl, auth: { type: "admin-secret", secret } });
  const token = process.env.ITERATE_BEARER_TOKEN?.trim();
  if (!token)
    throw new Error(
      "ITERATE_BEARER_TOKEN is required: a personal access token for the project (`pnpm exec iterate tokens create`, or the Dash's Sessions page)",
    );
  return await connectIterate({ baseUrl, auth: { type: "bearer", token } });
}
