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

function makeProjectIterator(projectId: string, signingKey: string) {
  return new DurableIterator<ProjectDurableObject>(`project:${projectId}`, {
    signingKey,
    // The client chooses the DO upgrade endpoint from token tags. That is more explicit
    // than inferring the namespace from the channel name string.
    tags: ["project-durable-object"],
  }).rpc("api");
}

function makeDeploymentIterator(deploymentId: string, signingKey: string) {
  return new DurableIterator<DeploymentDurableObject>(`deployment:${deploymentId}`, {
    signingKey,
    tags: ["deployment-durable-object"],
  }).rpc("api");
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

      // This procedure intentionally returns a live project snapshot stream.
      // The Jonas Land list page consumes it with TanStack Query live queries,
      // which mirrors the first-party oRPC guidance for Event Iterator / Durable Iterator.
      return makeProjectIterator(ctx.project.id, ctx.env.ENCRYPTION_SECRET);
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

      // This is the deployment event stream. The root iterator carries typed events
      // (`snapshot` and `log`) so the frontend can consume it through TanStack Query's
      // streamed helpers like a normal top-level async iterator, while `api.*` remains
      // available on the same websocket for imperative DO-local RPC when needed.
      return makeDeploymentIterator(input.deploymentId, ctx.env.ENCRYPTION_SECRET);
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
