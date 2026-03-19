import { z } from "zod/v4";
import { ORPCError } from "@orpc/server";
import { DurableIterator } from "@orpc/experimental-durable-iterator";
import {
  ProjectInput,
  projectProtectedMutation,
  projectProtectedProcedure,
} from "../procedures.ts";
import type { ProjectDurableObject } from "../../durable-objects/project.ts";

export const deploymentRouter = {
  list: projectProtectedProcedure.input(ProjectInput).handler(async ({ context: ctx }) => {
    if (!ctx.project.jonasLand) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Deployments are only available for jonasland projects",
      });
    }

    return ctx.env.PROJECT_DURABLE_OBJECT.getByName(`project:${ctx.project.id}`).listDeployments();
  }),

  connect: projectProtectedProcedure.input(ProjectInput).handler(({ context: ctx }) => {
    if (!ctx.project.jonasLand) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Deployments are only available for jonasland projects",
      });
    }

    return new DurableIterator<ProjectDurableObject>(`project:${ctx.project.id}`, {
      signingKey: ctx.env.ENCRYPTION_SECRET,
    }).rpc("deployments");
  }),

  create: projectProtectedMutation
    .input(
      z.object({
        ...ProjectInput.shape,
        name: z.string().min(1).max(100),
      }),
    )
    .handler(async ({ context: ctx, input }) => {
      if (!ctx.project.jonasLand) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Deployments are only available for jonasland projects",
        });
      }

      return ctx.env.PROJECT_DURABLE_OBJECT.getByName(`project:${ctx.project.id}`).createDeployment(
        {
          projectId: ctx.project.id,
          name: input.name,
        },
      );
    }),

  start: projectProtectedMutation
    .input(
      z.object({
        ...ProjectInput.shape,
        deploymentId: z.string(),
      }),
    )
    .handler(async ({ context: ctx, input }) => {
      if (!ctx.project.jonasLand) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Deployments are only available for jonasland projects",
        });
      }

      return ctx.env.PROJECT_DURABLE_OBJECT.getByName(`project:${ctx.project.id}`).startDeployment({
        deploymentId: input.deploymentId,
      });
    }),

  stop: projectProtectedMutation
    .input(
      z.object({
        ...ProjectInput.shape,
        deploymentId: z.string(),
      }),
    )
    .handler(async ({ context: ctx, input }) => {
      if (!ctx.project.jonasLand) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Deployments are only available for jonasland projects",
        });
      }

      return ctx.env.PROJECT_DURABLE_OBJECT.getByName(`project:${ctx.project.id}`).stopDeployment({
        deploymentId: input.deploymentId,
      });
    }),

  destroy: projectProtectedMutation
    .input(
      z.object({
        ...ProjectInput.shape,
        deploymentId: z.string(),
      }),
    )
    .handler(async ({ context: ctx, input }) => {
      if (!ctx.project.jonasLand) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Deployments are only available for jonasland projects",
        });
      }

      return ctx.env.PROJECT_DURABLE_OBJECT.getByName(
        `project:${ctx.project.id}`,
      ).destroyDeployment({
        deploymentId: input.deploymentId,
      });
    }),
};
