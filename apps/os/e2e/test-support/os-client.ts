import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { RpcStub } from "capnweb";
import { localDevServerBaseUrl } from "./dev-server.ts";
import { connectItx } from "~/itx-client.ts";
import type { Itx, Session } from "~/types.ts";

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
 * An admin itx handle against the deployment under test: the Session catalog
 * (no context) or a project itx (with context) — the same surfaces the
 * browser, REPL, and CLI use.
 */
export function createAdminOsItx(input?: { baseUrl?: string }): RpcStub<Session>;
export function createAdminOsItx(input: { baseUrl?: string; context: string }): RpcStub<Itx>;
export function createAdminOsItx(input?: { baseUrl?: string; context?: string }) {
  const baseUrl = input?.baseUrl ?? requireBaseUrl();
  const auth = { type: "admin-secret" as const, secret: requireAdminBearerToken() };
  return input?.context
    ? connectItx({ auth, baseUrl, projectId: input.context })
    : connectItx({ auth, baseUrl });
}

export function uniqueSuffix() {
  return `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}
