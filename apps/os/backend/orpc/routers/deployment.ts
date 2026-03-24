import { ORPCError } from "@orpc/server";
import { z } from "zod/v4";
import type { DeploymentDurableObject, DeploymentLog } from "../../durable-objects/deployment.ts";
import type { ProjectDurableObject } from "../../durable-objects/project.ts";
import {
  ProjectInput,
  projectProtectedMutation,
  projectProtectedProcedure,
} from "../procedures.ts";

const DeploymentInput = z.object({
  ...ProjectInput.shape,
  deploymentId: z.string(),
});

function assertJonaslandProject(project: { jonasLand: boolean }) {
  if (!project.jonasLand) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Deployments are only available for jonasland projects",
    });
  }
}

function getProjectDo(context: {
  project: { id: string; slug: string; jonasLand: boolean };
  env: {
    PROJECT_DURABLE_OBJECT: DurableObjectNamespace<ProjectDurableObject>;
    DEPLOYMENT_DURABLE_OBJECT: DurableObjectNamespace<DeploymentDurableObject>;
  };
}) {
  assertJonaslandProject(context.project);
  return context.env.PROJECT_DURABLE_OBJECT.getByName(`project:${context.project.id}`);
}

async function getDeploymentDo(input: {
  context: {
    env: {
      DEPLOYMENT_DURABLE_OBJECT: DurableObjectNamespace<DeploymentDurableObject>;
    };
  };
  projectDo: DurableObjectStub<ProjectDurableObject>;
  deploymentId: string;
}) {
  const hasDeployment = await input.projectDo.hasDeployment({ deploymentId: input.deploymentId });
  if (!hasDeployment) {
    throw new ORPCError("NOT_FOUND", {
      message: `Deployment ${input.deploymentId} not found for this project`,
    });
  }

  return input.context.env.DEPLOYMENT_DURABLE_OBJECT.getByName(`deployment:${input.deploymentId}`);
}

export const deploymentRouter = {
  list: projectProtectedProcedure.input(ProjectInput).handler(async ({ context }) => {
    return getProjectDo(context).listDeployments();
  }),

  create: projectProtectedMutation
    .input(
      z.object({
        ...ProjectInput.shape,
        name: z.string().min(1).max(100),
      }),
    )
    .handler(async ({ context, input }) => {
      return getProjectDo(context).createDeployment({
        name: input.name,
        primaryIngressHost: `${context.project.slug}.jonasland.local`,
      });
    }),

  makePrimary: projectProtectedMutation
    .input(DeploymentInput)
    .handler(async ({ context, input }) => {
      const projectDo = getProjectDo(context);
      await getDeploymentDo({ context, projectDo, deploymentId: input.deploymentId });
      return projectDo.setPrimaryDeployment({
        deploymentId: input.deploymentId,
        primaryIngressHost: `${context.project.slug}.jonasland.local`,
      });
    }),

  get: projectProtectedProcedure.input(DeploymentInput).handler(async ({ context, input }) => {
    const projectDo = getProjectDo(context);
    const deploymentDo = await getDeploymentDo({
      context,
      projectDo,
      deploymentId: input.deploymentId,
    });
    const [deployment, primaryDeploymentId] = await Promise.all([
      deploymentDo.getSummary(),
      projectDo.getPrimaryDeploymentId(),
    ]);

    return {
      deployment,
      isPrimary: primaryDeploymentId === input.deploymentId,
    };
  }),

  logs: projectProtectedProcedure.input(DeploymentInput).handler(async function* ({
    context,
    input,
    signal,
  }) {
    const projectDo = getProjectDo(context);
    const deploymentDo = await getDeploymentDo({
      context,
      projectDo,
      deploymentId: input.deploymentId,
    });
    // Keep logs on an ordinary top-level oRPC stream so the browser can use the documented
    // TanStack Query streamed API. The DO stays a small Cloudflare RPC target that only knows
    // how to list existing log rows and wait for the next appended row.
    const backlog = await deploymentDo.listLogs();

    let afterId = 0;
    for (const log of backlog) {
      afterId = log.id;
      yield log;
    }

    while (!signal?.aborted) {
      const log: DeploymentLog | null = await deploymentDo.waitForNextLog({
        afterId,
        timeoutMs: 10_000,
      });

      if (!log) {
        continue;
      }

      afterId = log.id;
      yield log;
    }
  }),

  start: projectProtectedMutation.input(DeploymentInput).handler(async ({ context, input }) => {
    const projectDo = getProjectDo(context);
    const deployment = await (
      await getDeploymentDo({ context, projectDo, deploymentId: input.deploymentId })
    ).start();
    await projectDo.syncDeployment(deployment);
    return deployment;
  }),

  stop: projectProtectedMutation.input(DeploymentInput).handler(async ({ context, input }) => {
    const projectDo = getProjectDo(context);
    const deployment = await (
      await getDeploymentDo({ context, projectDo, deploymentId: input.deploymentId })
    ).stop();
    await projectDo.syncDeployment(deployment);
    return deployment;
  }),

  destroy: projectProtectedMutation.input(DeploymentInput).handler(async ({ context, input }) => {
    const projectDo = getProjectDo(context);
    const deployment = await (
      await getDeploymentDo({ context, projectDo, deploymentId: input.deploymentId })
    ).destroy();
    await projectDo.syncDeployment(deployment);
    return deployment;
  }),
};
