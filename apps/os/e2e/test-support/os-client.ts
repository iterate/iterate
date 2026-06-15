import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { localDevServerBaseUrl } from "./dev-server.ts";
import { withItx, type ItxClient } from "~/itx/client.ts";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));

export function requireBaseUrl() {
  let baseUrl = process.env.APP_CONFIG_BASE_URL?.trim().replace(/\/+$/, "");
  baseUrl ||= localDevServerBaseUrl(appRoot);
  if (!baseUrl) {
    console.log(`No base URL found in environment, reading from Doppler.`);
    const dopplerEnv = execSync(`doppler run -- node -p 'JSON.stringify(process.env)'`);
    Object.assign(process.env, JSON.parse(dopplerEnv.toString()), process.env);
    baseUrl = process.env.APP_CONFIG_BASE_URL?.trim().replace(/\/+$/, "");
    baseUrl ||= localDevServerBaseUrl(appRoot);
  }
  if (!baseUrl) {
    throw new Error(
      "APP_CONFIG_BASE_URL is required for os e2e tests, or start local dev with `pnpm dev` first.",
    );
  }
  return baseUrl;
}

export function requireAdminBearerToken() {
  const token =
    process.env.OS_E2E_ADMIN_API_SECRET?.trim() ||
    process.env.OS_ADMIN_API_SECRET?.trim() ||
    process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
  if (!token) {
    throw new Error(
      "OS_E2E_ADMIN_API_SECRET, OS_ADMIN_API_SECRET, or APP_CONFIG_ADMIN_API_SECRET is required for admin os e2e tests.",
    );
  }
  return token;
}

export function requireRootAccessToken() {
  return requireAdminBearerToken();
}

/**
 * An admin (access "all") itx handle against the deployment under test. The
 * oRPC product surface is gone; e2e tests reach project + stream capabilities
 * through itx (the same handle the browser/REPL/CLI use).
 */
export function createAdminOsItx(input?: { baseUrl?: string; context?: string }): ItxClient {
  return withItx({
    baseUrl: input?.baseUrl ?? requireBaseUrl(),
    context: input?.context,
    token: requireAdminBearerToken(),
  });
}

export function uniqueSuffix() {
  return `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}
