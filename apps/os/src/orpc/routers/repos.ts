import { ORPCError } from "@orpc/server";
import type { RequestContext } from "~/request-context.ts";
import { getReposCapability } from "~/domains/repos/entrypoints/repo-capability.ts";
import { listConnectedIntegrationAccountStates } from "~/domains/integrations/durable-objects/integration-durable-object.ts";
import { DEFAULT_INTEGRATION_ACCOUNT } from "~/domains/integrations/integration-events.ts";
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
        const account = input.account ?? (await implicitGithubAccount(project.id));
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

/**
 * The github account a remote binds to when the caller doesn't name one.
 * Resolution is over CONNECTED accounts only, and zero connected is a clear
 * client error — silently journaling the remote against a phantom "default"
 * would register the webhook route where no tokens or webhooks live, and
 * auto-pull would never fire. (An EXPLICIT account may be unconnected: the
 * declared route simply goes live when that account connects.)
 */
async function implicitGithubAccount(projectId: string): Promise<string> {
  const connected = await listConnectedIntegrationAccountStates({
    projectId,
    integration: "github",
  });
  const accounts = connected.map((state) => state.account ?? DEFAULT_INTEGRATION_ACCOUNT);
  if (accounts.length === 0) {
    throw new ORPCError("BAD_REQUEST", {
      message:
        "No GitHub account is connected to this project. Connect GitHub first, or pass `account` explicitly.",
    });
  }
  if (accounts.includes(DEFAULT_INTEGRATION_ACCOUNT)) return DEFAULT_INTEGRATION_ACCOUNT;
  if (accounts.length === 1) return accounts[0]!;
  throw new ORPCError("BAD_REQUEST", {
    message: `Several GitHub accounts are connected (${accounts.join(", ")}) — pass \`account\` explicitly.`,
  });
}

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
