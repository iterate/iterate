import {
  createAdminOsItx,
  requireBaseUrl,
  requireAdminBearerToken,
  uniqueSuffix,
} from "./os-client.ts";
import { withItx } from "~/itx/client.ts";

/**
 * Create a disposable project against the deployment under test via itx (the
 * admin handle has access "all"). Returns the project plus a base URL and an
 * async disposer that removes it. Project create/remove run on a short-lived
 * global itx session; per-project work narrows with `itx.projects.get(id)`.
 */
export async function createTestProject(opts: { slugPrefix: string }) {
  const baseUrl = requireBaseUrl();
  const slugPrefix = opts.slugPrefix;
  using itx = createAdminOsItx({ baseUrl });

  let project = await itx.projects.create({
    // you get invalid DNS name errors if the slug is too long
    slug: `${slugPrefix.slice(0, 20)}-${uniqueSuffix()}`.replace("--", "-"),
  });

  let disposed = false;
  return {
    baseUrl,
    /** A fresh admin itx handle narrowed to this project. */
    itx(context?: string) {
      return withItx({
        baseUrl,
        context: context ?? project.id,
        token: requireAdminBearerToken(),
      });
    },
    get project() {
      return project;
    },
    async updateConfig(input: { customHostname?: string | null }) {
      using session = createAdminOsItx({ baseUrl });
      project = {
        ...project,
        ...(await session.projects.updateConfig({
          id: project.id,
          customHostname: input.customHostname,
        })),
      };
      return project;
    },
    async [Symbol.asyncDispose]() {
      if (disposed) return;
      disposed = true;
      using session = createAdminOsItx({ baseUrl });
      await session.projects.remove({ id: project.id }).catch(() => undefined);
    },
  };
}
