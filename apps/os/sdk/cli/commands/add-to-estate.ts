import { z } from "zod";
import { eq } from "drizzle-orm";
import { t } from "../config.ts";
import { db, schema } from "../cli-db.ts";

export const addUserToEstate = t.procedure
  .input(
    z.object({
      estateId: z.string(),
      email: z.string().email("Invalid email address"),
      role: z
        .enum(["member", "admin", "owner", "guest"])
        .optional()
        .default("member")
        .describe("Role to assign to the user in the organization"),
    }),
  )
  .mutation(async ({ input }) => {
    const { estateId, email, role } = input;

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

    // Find the estate and get its organization
    const estate = await db.query.estate.findFirst({
      where: eq(schema.estate.id, estateId),
      with: {
        organization: true,
      },
    });

    if (!estate) {
      throw new Error(`Estate with ID ${estateId} not found`);
    }

    // Upsert the membership - this will insert if not exists, or update if it does
    const [membership] = await db
      .insert(schema.organizationUserMembership)
      .values({
        userId: user.id,
        organizationId: estate.organizationId,
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
      `✅ Successfully ${action} user ${email} ${isNew ? "to" : "in"} organization ${estate.organization.name} with role: ${role}`,
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
        id: estate.organization.id,
        name: estate.organization.name,
      },
      estate: {
        id: estate.id,
        name: estate.name,
      },
      membership: {
        role: membership.role,
        isNew: isNew,
      },
    };
  });
