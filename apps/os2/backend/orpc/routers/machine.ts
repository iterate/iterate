import { z } from "zod/v4";
import { eq, and } from "drizzle-orm";
import { ORPCError, protectedProcedure, ProjectInput } from "../orpc.ts";
import { machine, MachineType, organization, organizationUserMembership, project } from "../../db/schema.ts";
import type { Context } from "../context.ts";

const projectLookup = async (
  db: Context["db"],
  organizationSlug: string,
  projectSlug: string,
  userId: string,
  userRole: string | null | undefined,
) => {
  const org = await db.query.organization.findFirst({
    where: eq(organization.slug, organizationSlug),
  });

  if (!org) {
    throw new ORPCError("NOT_FOUND", {
      message: `Organization with slug ${organizationSlug} not found`,
    });
  }

  const membership = await db.query.organizationUserMembership.findFirst({
    where: and(
      eq(organizationUserMembership.organizationId, org.id),
      eq(organizationUserMembership.userId, userId),
    ),
  });

  if (!membership && userRole !== "admin") {
    throw new ORPCError("FORBIDDEN", {
      message: "User does not have access to organization",
    });
  }

  const proj = await db.query.project.findFirst({
    where: and(eq(project.organizationId, org.id), eq(project.slug, projectSlug)),
    with: {
      repo: true,
      envVars: true,
      accessTokens: true,
      connections: true,
    },
  });

  if (!proj) {
    throw new ORPCError("NOT_FOUND", {
      message: `Project with slug ${projectSlug} not found`,
    });
  }

  return { org, membership, project: proj };
};

export const machineRouter = {
  list: protectedProcedure
    .input(ProjectInput.extend({ includeArchived: z.boolean().default(false).optional() }))
    .handler(async ({ context, input }) => {
      const { project: proj } = await projectLookup(
        context.db,
        input.organizationSlug,
        input.projectSlug,
        context.user.id,
        context.user.role,
      );

      const includeArchived = input.includeArchived ?? false;

      const machines = await context.db.query.machine.findMany({
        where: includeArchived
          ? eq(machine.projectId, proj.id)
          : and(eq(machine.projectId, proj.id), eq(machine.state, "started")),
        orderBy: (m, { desc }) => [desc(m.createdAt)],
      });

      return machines;
    }),

  byId: protectedProcedure
    .input(ProjectInput.extend({ machineId: z.string() }))
    .handler(async ({ context, input }) => {
      const { project: proj } = await projectLookup(
        context.db,
        input.organizationSlug,
        input.projectSlug,
        context.user.id,
        context.user.role,
      );

      const m = await context.db.query.machine.findFirst({
        where: and(
          eq(machine.id, input.machineId),
          eq(machine.projectId, proj.id),
        ),
      });

      if (!m) {
        throw new ORPCError("NOT_FOUND", {
          message: "Machine not found",
        });
      }

      return m;
    }),

  create: protectedProcedure
    .input(
      ProjectInput.extend({
        name: z.string().min(1).max(100),
        type: z.enum(MachineType).default("daytona"),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .handler(async ({ context, input }) => {
      const { project: proj } = await projectLookup(
        context.db,
        input.organizationSlug,
        input.projectSlug,
        context.user.id,
        context.user.role,
      );

      const [newMachine] = await context.db
        .insert(machine)
        .values({
          name: input.name,
          type: input.type,
          projectId: proj.id,
          state: "started",
          metadata: input.metadata ?? {},
        })
        .returning();

      if (!newMachine) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: "Failed to create machine",
        });
      }

      return newMachine;
    }),

  archive: protectedProcedure
    .input(ProjectInput.extend({ machineId: z.string() }))
    .handler(async ({ context, input }) => {
      const { project: proj } = await projectLookup(
        context.db,
        input.organizationSlug,
        input.projectSlug,
        context.user.id,
        context.user.role,
      );

      const [updated] = await context.db
        .update(machine)
        .set({ state: "archived" })
        .where(
          and(
            eq(machine.id, input.machineId),
            eq(machine.projectId, proj.id),
          ),
        )
        .returning();

      if (!updated) {
        throw new ORPCError("NOT_FOUND", {
          message: "Machine not found",
        });
      }

      return updated;
    }),

  unarchive: protectedProcedure
    .input(ProjectInput.extend({ machineId: z.string() }))
    .handler(async ({ context, input }) => {
      const { project: proj } = await projectLookup(
        context.db,
        input.organizationSlug,
        input.projectSlug,
        context.user.id,
        context.user.role,
      );

      const [updated] = await context.db
        .update(machine)
        .set({ state: "started" })
        .where(
          and(
            eq(machine.id, input.machineId),
            eq(machine.projectId, proj.id),
          ),
        )
        .returning();

      if (!updated) {
        throw new ORPCError("NOT_FOUND", {
          message: "Machine not found",
        });
      }

      return updated;
    }),

  delete: protectedProcedure
    .input(ProjectInput.extend({ machineId: z.string() }))
    .handler(async ({ context, input }) => {
      const { project: proj } = await projectLookup(
        context.db,
        input.organizationSlug,
        input.projectSlug,
        context.user.id,
        context.user.role,
      );

      const result = await context.db
        .delete(machine)
        .where(
          and(
            eq(machine.id, input.machineId),
            eq(machine.projectId, proj.id),
          ),
        )
        .returning();

      if (result.length === 0) {
        throw new ORPCError("NOT_FOUND", {
          message: "Machine not found",
        });
      }

      return { success: true };
    }),

  update: protectedProcedure
    .input(
      ProjectInput.extend({
        machineId: z.string(),
        name: z.string().min(1).max(100).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .handler(async ({ context, input }) => {
      const { project: proj } = await projectLookup(
        context.db,
        input.organizationSlug,
        input.projectSlug,
        context.user.id,
        context.user.role,
      );

      const [updated] = await context.db
        .update(machine)
        .set({
          ...(input.name && { name: input.name }),
          ...(input.metadata && { metadata: input.metadata }),
        })
        .where(
          and(
            eq(machine.id, input.machineId),
            eq(machine.projectId, proj.id),
          ),
        )
        .returning();

      if (!updated) {
        throw new ORPCError("NOT_FOUND", {
          message: "Machine not found",
        });
      }

      return updated;
    }),
};
