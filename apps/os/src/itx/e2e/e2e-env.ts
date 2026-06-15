// Shared environment plumbing for the itx e2e suites (Node side): which
// deployed worker to talk to and how to authenticate against it. The browser
// suite cannot read process.env, so vitest.config.ts injects the same values
// there via `define` (__ITX_BROWSER_E2E__) instead of importing this file.

import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
import { withItx, type ItxClient } from "../client.ts";
import { localDevServerBaseUrl } from "../../../e2e/test-support/dev-server.ts";

const appRoot = fileURLToPath(new URL("../../..", import.meta.url));

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
    localDevServerBaseUrl(appRoot) ||
    "";
  if (!url) {
    throw new Error(
      "APP_CONFIG_BASE_URL is required for itx e2e tests, or start local dev with `pnpm dev` first.",
    );
  }
  return url;
}

/** A global (admin-access) handle on the deployment under test. */
export function connectGlobal(): ItxClient {
  return withItx({ baseUrl: baseUrl(), token: adminApiSecret() });
}

const TRANSIENT_PROJECT_CREATE_BACKOFF_MS = [500, 1_500, 3_000];

/**
 * Preview e2e creates many short-lived projects against a remote Worker. A
 * transient Cap'n Web disconnect can drop the response after the server has
 * already done useful work; retry only those transport failures.
 */
export async function createItxProject(
  itx: Pick<ItxClient, "projects">,
  input: { slug: string },
): Promise<{ id: string; slug: string }> {
  for (const backoffMs of TRANSIENT_PROJECT_CREATE_BACKOFF_MS) {
    try {
      return (await itx.projects.create(input)) as { id: string; slug: string };
    } catch (error) {
      if (!isTransientProjectCreateError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  return (await itx.projects.create(input)) as { id: string; slug: string };
}

function isTransientProjectCreateError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Network connection lost");
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
