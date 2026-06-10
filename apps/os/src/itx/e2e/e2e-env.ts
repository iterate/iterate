// Shared environment plumbing for the itx e2e suites (Node side): which
// deployed worker to talk to and how to authenticate against it. The browser
// suite cannot read process.env, so vitest.config.ts injects the same values
// there via `define` (__ITX_BROWSER_E2E__) instead of importing this file.

import { afterAll } from "vitest";
import { connectItx, type ItxClient } from "../client.ts";

export function adminApiSecret() {
  const secret =
    process.env.OS_E2E_ADMIN_API_SECRET?.trim() ||
    process.env.OS_ADMIN_API_SECRET?.trim() ||
    process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ||
    "";
  if (!secret) throw new Error("APP_CONFIG_ADMIN_API_SECRET is required for itx e2e tests.");
  return secret;
}

export function baseUrl() {
  const url =
    process.env.OS_ITX_E2E_BASE_URL?.trim().replace(/\/+$/, "") ||
    process.env.APP_CONFIG_BASE_URL?.trim().replace(/\/+$/, "") ||
    "";
  if (!url) throw new Error("APP_CONFIG_BASE_URL is required for itx e2e tests.");
  return url;
}

/** A global (admin-access) handle on the deployment under test. */
export function connectGlobal(): ItxClient {
  return connectItx({ baseUrl: baseUrl(), token: adminApiSecret() });
}

/**
 * Best-effort cleanup for projects a suite creates: push every created
 * project id onto the returned array and an afterAll hook removes them via
 * itx.projects.remove. Cleanup failures must never fail the suite.
 */
export function registerCreatedProjectCleanup(): string[] {
  const createdProjectIds: string[] = [];
  afterAll(async () => {
    try {
      using itx = connectGlobal();
      for (const id of createdProjectIds.toReversed()) {
        await itx.projects.remove({ id }).catch(() => {});
      }
    } catch {
      // Best-effort only.
    }
  });
  return createdProjectIds;
}
