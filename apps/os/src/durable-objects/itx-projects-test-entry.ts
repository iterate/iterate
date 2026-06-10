import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { ItxProjects, type ItxRuntime } from "~/itx/handle.ts";
import { GLOBAL_CONTEXT_ID } from "~/itx/protocol.ts";
import { parseConfig } from "~/config.ts";
import { adminPrincipal, createUserPrincipal, type UserPrincipal } from "~/auth/principal.ts";

/** Stands in for the real Project DO: create() bootstraps via createProject
 * and shapes its result via ingressUrl — both must answer, nothing more. */
export class FakeProjectDurableObject extends DurableObject {
  async createProject(input: { projectId: string; slug: string }) {
    return { id: input.projectId, slug: input.slug };
  }

  async ingressUrl() {
    return "https://fake-project.test";
  }
}

type HarnessUser = {
  id: string;
  organizations: Parameters<typeof createUserPrincipal>[0]["organizations"];
};

/**
 * Drives ItxProjects.create exactly the way /api/itx connect does: a runtime
 * with connect-time access + principal (fetch.ts → resolveItx), then the
 * create call — and the thrown ItxError must carry its code back across this
 * harness's Workers RPC boundary into the test.
 */
export class ItxProjectsHarness extends WorkerEntrypoint<Env> {
  async create(input: {
    access: "all" | string[];
    project: { id?: string; slug: string; organizationSlug?: string };
    user?: HarnessUser;
  }) {
    return await new ItxProjects(this.#runtime(input)).create(input.project);
  }

  #runtime(input: { access: "all" | string[]; user?: HarnessUser }): ItxRuntime {
    return {
      access: input.access,
      config: parseConfig(this.env),
      contextId: GLOBAL_CONTEXT_ID,
      env: this.env,
      exports: this.ctx.exports as unknown as ItxRuntime["exports"],
      principal: input.user ? userPrincipal(input.user) : adminPrincipalFor(input.access),
      projectId: null,
    };
  }
}

function userPrincipal(user: HarnessUser): UserPrincipal {
  return createUserPrincipal({ userId: user.id, organizations: user.organizations, projects: [] });
}

function adminPrincipalFor(access: "all" | string[]) {
  // Mirrors connect-time reality: the admin secret resolves adminPrincipal and
  // access "all"; a named-access runtime without a user is a cap-style handle
  // that carries no principal at all.
  return access === "all" ? adminPrincipal : undefined;
}

export default {
  async fetch() {
    return new Response("itx projects test worker");
  },
} satisfies ExportedHandler<Env>;
