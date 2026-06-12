import { ORPCError } from "@orpc/server";
import type { RequestContext } from "~/request-context.ts";
import { getReposCapability } from "~/domains/repos/entrypoints/repo-capability.ts";
import { resolveImplicitAccount } from "~/domains/integrations/durable-objects/integration-durable-object.ts";
import { os, projectScopeMiddleware } from "~/orpc/orpc.ts";
import { requireProjectScope } from "~/orpc/project-access.ts";

export const projectReposRouter = {
  list: os.project.repos.list.use(projectScopeMiddleware).handler(async ({ context }) => {
    const project = requireProjectScope(context);
    const repos = await getProjectReposCapability(context, project.id).list();
    return { repos };
  }),
  create: os.project.repos.create
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      try {
        return await getProjectReposCapability(context, project.id).createInfo({
          projectSlug: project.slug,
          slug: input.slug,
        });
      } catch (error) {
        throw toRepoORPCError(error);
      }
    }),
  get: os.project.repos.get.use(projectScopeMiddleware).handler(async ({ context, input }) => {
    const project = requireProjectScope(context);
    try {
      return await getProjectReposCapability(context, project.id).getInfo({
        slug: input.repoSlug,
      });
    } catch (error) {
      throw toRepoORPCError(error);
    }
  }),
  configureGithubRemote: os.project.repos.configureGithubRemote
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      try {
        const account =
          input.account ??
          (await resolveImplicitAccount({ projectId: project.id, integration: "github" }));
        const handle = await getProjectReposCapability(context, project.id).get({
          slug: input.repoSlug,
        });
        return await handle.configureRemote({
          provider: "github",
          account,
          owner: input.owner,
          repo: input.repo,
          ...(input.branch == null ? {} : { branch: input.branch }),
          sync: input.sync,
        });
      } catch (error) {
        throw toRepoORPCError(error);
      }
    }),
  getSyncState: os.project.repos.getSyncState
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      try {
        const handle = await getProjectReposCapability(context, project.id).get({
          slug: input.repoSlug,
        });
        return await handle.getSyncState();
      } catch (error) {
        throw toRepoORPCError(error);
      }
    }),
};

function getProjectReposCapability(context: RequestContext, projectId: string) {
  if (!context.workerExports) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Worker exports are not available.",
    });
  }

  return getReposCapability({
    exports: context.workerExports,
    props: {
      projectId,
    },
  });
}

function toRepoORPCError(error: unknown) {
  if (error instanceof ORPCError) return error;
  if (!(error instanceof Error)) return error;

  if (error.message.includes("already exists")) {
    return new ORPCError("CONFLICT", { message: error.message });
  }

  if (error.message.includes("not found") || error.message.includes("has not been created")) {
    return new ORPCError("NOT_FOUND", { message: error.message });
  }

  if (error.message.includes("must be lowercase") || error.message.includes("slug is required")) {
    return new ORPCError("BAD_REQUEST", { message: error.message });
  }

  return error;
}
