import { z } from "zod";
import { eq } from "drizzle-orm";
import { t } from "../config.ts";
import { db, schema } from "../cli-db.ts";

export const addUserToInstallation = t.procedure
  .input(
    z.object({
      installationId: z.string(),
      email: z.string().email("Invalid email address"),
      role: z
        .enum(["member", "admin", "owner", "guest"])
        .optional()
        .default("member")
        .describe("Role to assign to the user in the organization"),
    }),
  )
  .mutation(async ({ input }) => {
    const { installationId, email, role } = input;

    // Check if DRIZZLE_RW_POSTGRES_CONNECTION_STRING is available at runtime
    if (!process.env.DRIZZLE_RW_POSTGRES_CONNECTION_STRING) {
      throw new Error(
        "DRIZZLE_RW_POSTGRES_CONNECTION_STRING environment variable is not set. This is required to connect to the database.",
      );
    }

    // Find the user by email
    const user = await db.query.user.findFirst({
      where: eq(schema.user.email, email),
    });

    if (!user) {
      throw new Error(`User with email ${email} not found in the database`);
    }

    // Find the installation and get its organization
    const installation = await db.query.installation.findFirst({
      where: eq(schema.installation.id, installationId),
      with: {
        organization: true,
      },
    });

    if (!installation) {
      throw new Error(`Installation with ID ${installationId} not found`);
    }

    // Upsert the membership - this will insert if not exists, or update if it does
    const [membership] = await db
      .insert(schema.organizationUserMembership)
      .values({
        userId: user.id,
        organizationId: installation.organizationId,
        role: role,
      })
      .onConflictDoUpdate({
        target: [
          schema.organizationUserMembership.userId,
          schema.organizationUserMembership.organizationId,
        ],
        set: {
          role: role,
          updatedAt: new Date(),
        },
      })
      .returning();

    // Determine if this was a new insert or an update by checking if createdAt is very recent
    const isNew = Date.now() - new Date(membership.createdAt).getTime() < 1000;

    const action = isNew ? "added to" : "updated in";
    console.log(
      `✅ Successfully ${action} user ${email} ${isNew ? "to" : "in"} organization ${installation.organization.name} with role: ${role}`,
    );

    return {
      success: true,
      message: `User ${email} ${isNew ? "added to" : "updated in"} organization with role: ${role}`,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
      organization: {
        id: installation.organization.id,
        name: installation.organization.name,
      },
      installation: {
        id: installation.id,
        name: installation.name,
      },
      membership: {
        role: membership.role,
        isNew: isNew,
      },
    };
  });
