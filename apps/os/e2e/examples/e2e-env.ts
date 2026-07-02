// Shared environment plumbing for the itx e2e suites (Node side): which
// deployed worker to talk to and how to authenticate against it. The browser
// suite cannot read process.env, so vitest.config.ts injects the same values
// there via `define` (__ITX_BROWSER_E2E__) instead of importing this file.

import { fileURLToPath } from "node:url";
import type { RpcStub } from "capnweb";
import { connectItx } from "../../src/itx-client.ts";
import type { Itx, Session } from "../../src/types.ts";
import { localDevServerBaseUrl } from "../test-support/dev-server.ts";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));

export function adminApiSecret() {
  const secret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ?? "";
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

/** An admin Session on the deployment under test (the catalog that vends itxs). */
export function connectGlobal(): RpcStub<Session> {
  return connectItx({
    auth: { secret: adminApiSecret(), type: "admin-secret" },
    baseUrl: baseUrl(),
  });
}

/** A project-scoped itx on the deployment under test, via admin auth. */
export function connectProject(projectId: string): RpcStub<Itx> {
  return connectItx({
    auth: { secret: adminApiSecret(), type: "admin-secret" },
    baseUrl: baseUrl(),
    projectId,
  });
}
