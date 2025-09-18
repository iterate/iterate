import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { typeid } from "typeid-js";
import { type DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { env } from "../../env.ts";
import { integrationsPlugin } from "./integrations.ts";
import { createUserOrganizationAndEstate } from "./hooks.ts";

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
            await createUserOrganizationAndEstate(db, user.id, user.name).catch((error) => {
              console.error(error);
              console.error("❌ Error creating organization and estate", user);
            });
          },
        },
      },
    },
  });

export type Auth = ReturnType<typeof getAuth>;
export type AuthSession = Awaited<ReturnType<Auth["api"]["getSession"]>>;
