import type { RpcStub } from "capnweb";
import { createAdminOsItx, requireBaseUrl, uniqueSuffix } from "./os-client.ts";
import type { Agent, Itx } from "~/types.ts";
import { connectItx } from "~/itx-client.ts";

/**
 * Create a disposable project against the deployment under test via itx (the
 * admin handle may create projects). Returns the project plus a base URL and
 * an async disposer.
 *
 * NOTE: itx has no `projects.remove` yet (tasks/os-project-archival.md), so
 * disposal is a no-op — dev/preview stages accumulate throwaway projects and
 * are periodically reset. The `await using` shape is kept so tests don't churn
 * when removal lands.
 */
export async function createTestProject(opts: { slugPrefix: string }) {
  const baseUrl = requireBaseUrl();
  const slugPrefix = opts.slugPrefix;
  // you get invalid DNS name errors if the slug is too long
  const slug = `${slugPrefix.slice(0, 20)}-${uniqueSuffix()}`.replace("--", "-");

  using session = createAdminOsItx({ baseUrl });
  using created = session.projects.create({ slug });
  const description = await created.describe();
  const project = { id: description.projectId, slug };

  return {
    baseUrl,
    /** A fresh admin itx handle narrowed to this project (or an agent in it). */
    itx(): RpcStub<Itx> {
      return createAdminOsItx({ baseUrl, context: project.id });
    },
    agent(agentPath: string): RpcStub<Agent> {
      return connectItx({
        agentPath,
        auth: adminAuth(),
        baseUrl,
        projectId: project.id,
      });
    },
    get project() {
      return project;
    },
    [Symbol.asyncDispose]() {
      // TODO(tasks/os-project-archival.md): project removal on itx.
      return Promise.resolve();
    },
  };
}

function adminAuth() {
  const secret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
  if (!secret) throw new Error("APP_CONFIG_ADMIN_API_SECRET is required for e2e tests.");
  return { type: "admin-secret" as const, secret };
}
