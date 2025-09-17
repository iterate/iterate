import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { typeid } from "typeid-js";
import { type DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { env } from "../../env.ts";
import { integrationsPlugin } from "./integrations.ts";

// Function to create organization and estate for new users
export const createUserOrganizationAndEstate = async (db: DB, userId: string, userName: string) => {
  try {
    const existingMembership = await db.query.organizationUserMembership.findFirst({
      where: (membership, { eq }) => eq(membership.userId, userId),
    });

    // Only create organization and estate for new users
    if (!existingMembership) {
      // Use a transaction to ensure atomicity
      await db.transaction(async (tx) => {
        // Create organization
        const organizationResult = await tx
          .insert(schema.organization)
          .values({
            name: `${userName}'s Organization`,
          })
          .returning();

        const organization = organizationResult[0];

        if (!organization) {
          throw new Error("Failed to create organization");
        }

        // Create organization membership for the user
        await tx.insert(schema.organizationUserMembership).values({
          organizationId: organization.id,
          userId: userId,
          role: "owner",
        });

        // Create estate
        await tx.insert(schema.estate).values({
          name: `${userName}'s Estate`,
          organizationId: organization.id,
        });
        console.log(`✅ Created organization and estate for user: ${userName}`);
      });
    }
  } catch (error) {
    console.error("❌ Error creating organization and estate:", error);
    // Don't throw error to avoid breaking the signup flow
  }
};

export const getAuth = (db: DB) =>
  betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema,
    }),
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["google"],
        allowDifferentEmails: true,
      },
    },
    plugins: [integrationsPlugin()],
    socialProviders: {
      google: {
        scope: [
          "https://www.googleapis.com/auth/userinfo.email",
          "https://www.googleapis.com/auth/userinfo.profile",
          "openid",
        ],
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },
    advanced: {
      database: {
        generateId: (opts) => {
          const map = {
            account: "acc",
            session: "ses",
            user: "usr",
            verification: "ver",
          } as Record<string, string>;

          return typeid(map[opts.model] ?? opts.model).toString();
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            console.log("🚀 User created", user);
            await createUserOrganizationAndEstate(db, user.id, user.name);
          },
        },
      },
    },
  });

export type Auth = ReturnType<typeof getAuth>;
export type AuthSession = Awaited<ReturnType<Auth["api"]["getSession"]>>;
