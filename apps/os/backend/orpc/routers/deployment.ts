import { DurableIterator } from "@orpc/experimental-durable-iterator";
import { ORPCError } from "@orpc/server";
import { z } from "zod/v4";
import type { DeploymentDurableObject } from "../../durable-objects/deployment.ts";
import type { ProjectDurableObject } from "../../durable-objects/project.ts";
import {
  ProjectInput,
  projectProtectedMutation,
  projectProtectedProcedure,
} from "../procedures.ts";

async function getProjectStub(ctx: {
  project: { id: string; slug: string; jonasLand: boolean };
  env: {
    ENCRYPTION_SECRET: string;
    PROJECT_DURABLE_OBJECT: DurableObjectNamespace<ProjectDurableObject>;
  };
}) {
  if (!ctx.project.jonasLand) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Deployments are only available for jonasland projects",
    });
  }

  const stub = ctx.env.PROJECT_DURABLE_OBJECT.getByName(`project:${ctx.project.id}`);
  await stub.initialize({
    projectId: ctx.project.id,
    primaryIngressHost: `${ctx.project.slug}.jonasland.local`,
  });
  return stub;
}

async function assertDeploymentBelongsToProject(
  stub: DurableObjectStub<ProjectDurableObject>,
  deploymentId: string,
) {
  const hasDeployment = await stub.hasDeployment({ deploymentId });
  if (!hasDeployment) {
    throw new ORPCError("NOT_FOUND", {
      message: `Deployment ${deploymentId} not found for this project`,
    });
  }
}

export const deploymentRouter = {
  list: projectProtectedProcedure.input(ProjectInput).handler(async ({ context: ctx }) => {
    const projectStub = await getProjectStub(ctx);
    return projectStub.listDeployments();
  }),

  create: projectProtectedMutation
    .input(
      z.object({
        ...ProjectInput.shape,
        name: z.string().min(1).max(100),
      }),
    )
    .handler(async ({ context: ctx, input }) => {
      const projectStub = await getProjectStub(ctx);
      return projectStub.createDeployment({ name: input.name });
    }),

  makePrimary: projectProtectedMutation
    .input(
      z.object({
        ...ProjectInput.shape,
        deploymentId: z.string(),
      }),
    )
    .handler(async ({ context: ctx, input }) => {
      const projectStub = await getProjectStub(ctx);
      await assertDeploymentBelongsToProject(projectStub, input.deploymentId);
      return projectStub.setPrimaryDeployment({ deploymentId: input.deploymentId });
    }),

  connectProject: projectProtectedProcedure
    .input(ProjectInput)
    .handler(async ({ context: ctx }) => {
      await getProjectStub(ctx);

      return new DurableIterator<ProjectDurableObject>(`project:${ctx.project.id}`, {
        signingKey: ctx.env.ENCRYPTION_SECRET,
      }).rpc("deployments");
    }),

  get: projectProtectedProcedure
    .input(
      z.object({
        ...ProjectInput.shape,
        deploymentId: z.string(),
      }),
    )
    .handler(async ({ context: ctx, input }) => {
      const projectStub = await getProjectStub(ctx);
      await assertDeploymentBelongsToProject(projectStub, input.deploymentId);

      const [snapshot, primaryDeploymentId] = await Promise.all([
        ctx.env.DEPLOYMENT_DURABLE_OBJECT.getByName(
          `deployment:${input.deploymentId}`,
        ).getSnapshot(),
        projectStub.getPrimaryDeploymentId(),
      ]);

      return {
        ...snapshot,
        isPrimary: primaryDeploymentId === input.deploymentId,
      };
    }),

  connect: projectProtectedProcedure
    .input(
      z.object({
        ...ProjectInput.shape,
        deploymentId: z.string(),
      }),
    )
    .handler(async ({ context: ctx, input }) => {
      const projectStub = await getProjectStub(ctx);
      await assertDeploymentBelongsToProject(projectStub, input.deploymentId);

      return new DurableIterator<DeploymentDurableObject>(`deployment:${input.deploymentId}`, {
        signingKey: ctx.env.ENCRYPTION_SECRET,
      }).rpc("deployment");
    }),

  start: projectProtectedMutation
    .input(
      z.object({
        ...ProjectInput.shape,
        deploymentId: z.string(),
      }),
    )
    .handler(async ({ context: ctx, input }) => {
      const projectStub = await getProjectStub(ctx);
      await assertDeploymentBelongsToProject(projectStub, input.deploymentId);

      return ctx.env.DEPLOYMENT_DURABLE_OBJECT.getByName(
        `deployment:${input.deploymentId}`,
      ).start();
    }),

  stop: projectProtectedMutation
    .input(
      z.object({
        ...ProjectInput.shape,
        deploymentId: z.string(),
      }),
    )
    .handler(async ({ context: ctx, input }) => {
      const projectStub = await getProjectStub(ctx);
      await assertDeploymentBelongsToProject(projectStub, input.deploymentId);

      return ctx.env.DEPLOYMENT_DURABLE_OBJECT.getByName(`deployment:${input.deploymentId}`).stop();
    }),

  destroy: projectProtectedMutation
    .input(
      z.object({
        ...ProjectInput.shape,
        deploymentId: z.string(),
      }),
    )
    .handler(async ({ context: ctx, input }) => {
      const projectStub = await getProjectStub(ctx);
      await assertDeploymentBelongsToProject(projectStub, input.deploymentId);

      return ctx.env.DEPLOYMENT_DURABLE_OBJECT.getByName(
        `deployment:${input.deploymentId}`,
      ).destroy();
    }),
};
