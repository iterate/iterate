// Shared environment plumbing for the itx e2e suites: which deployed worker
// to talk to and how to authenticate against it.

import { fileURLToPath } from "node:url";
import type { RpcStub } from "capnweb";
import { connectItx } from "iterate/node";
import type { Project as ProjectRpcTarget, Session } from "../../src/itx-api.generated.ts";
import { resolveBaseUrl } from "../test-support/dev-server.ts";
import { withTestProjectIdentifiers } from "../test-support/with-test-project-identifiers.ts";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));

export function adminApiSecret() {
  const secret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ?? "";
  if (!secret) throw new Error("APP_CONFIG_ADMIN_API_SECRET is required for itx e2e tests.");
  return secret;
}

export function baseUrl() {
  const url = resolveBaseUrl(appRoot) ?? "";
  if (!url) {
    throw new Error(
      "APP_CONFIG_BASE_URL is required for itx e2e tests, or start local dev with `pnpm dev` first.",
    );
  }
  return url;
}

/** An admin Session on the deployment under test (the catalog that vends itxs). */
export function connectGlobal(): RpcStub<Session> {
  return withTestProjectIdentifiers(
    connectItx({
      auth: { secret: adminApiSecret(), type: "admin-secret" },
      baseUrl: baseUrl(),
    }),
  );
}

/** A project-scoped itx on the deployment under test, via admin auth. */
export function connectProject(projectId: string): RpcStub<ProjectRpcTarget> {
  return connectItx({
    auth: { secret: adminApiSecret(), type: "admin-secret" },
    baseUrl: baseUrl(),
    projectId,
  });
}
