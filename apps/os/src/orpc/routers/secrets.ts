import { ORPCError } from "@orpc/server";
import type { AppContext } from "~/context.ts";
import { getSecretsCapability } from "~/domains/secrets/entrypoints/secrets-capability.ts";
import { os, projectScopeMiddleware } from "~/orpc/orpc.ts";
import { requireProjectScope } from "~/orpc/project-access.ts";

export const projectSecretsRouter = {
  list: os.project.secrets.list.use(projectScopeMiddleware).handler(async ({ context }) => {
    const project = requireProjectScope(context);
    const secrets = await getProjectSecretsCapability(context, project.id).listSecrets();
    return { secrets };
  }),
  get: os.project.secrets.get.use(projectScopeMiddleware).handler(async ({ context, input }) => {
    const project = requireProjectScope(context);
    try {
      return await getProjectSecretsCapability(context, project.id).getSecretSummary({
        id: input.id,
      });
    } catch (error) {
      throw toSecretsORPCError(error);
    }
  }),
  upsert: os.project.secrets.upsert
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      try {
        return await getProjectSecretsCapability(context, project.id).setSecret({
          key: input.key,
          material: input.material,
          metadata: input.metadata,
        });
      } catch (error) {
        throw toSecretsORPCError(error);
      }
    }),
  remove: os.project.secrets.remove
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      return await getProjectSecretsCapability(context, project.id).deleteSecretById({
        id: input.id,
      });
    }),
};

function getProjectSecretsCapability(context: AppContext, projectId: string) {
  if (!context.workerExports) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Worker exports are not available.",
    });
  }

  return getSecretsCapability({
    exports: context.workerExports,
    props: {
      projectId,
    },
  });
}

function toSecretsORPCError(error: unknown) {
  if (error instanceof ORPCError) return error;
  if (!(error instanceof Error)) return error;

  if (error.message.includes("was not found") || error.message.includes("not found")) {
    return new ORPCError("NOT_FOUND", { message: error.message });
  }

  if (error.message.includes("required")) {
    return new ORPCError("BAD_REQUEST", { message: error.message });
  }

  return error;
}
