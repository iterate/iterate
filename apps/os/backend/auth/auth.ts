import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { typeid } from "typeid-js";
import { type DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { env } from "../../env.ts";
import { logger } from "../tag-logger.ts";
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
    // for now, we only want to enable email and password login if we know we need it for testing
    ...(import.meta.env.VITE_ENABLE_TEST_ADMIN_USER
      ? { emailAndPassword: { enabled: true } }
      : ({} as never)), // need to cast to never to make typescript think we can call APIs like `auth.api.createUser` - but this will fail at runtime if we try to use it in production
    plugins: [admin(), integrationsPlugin()],
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
              logger.error(error);
              logger.error("❌ Error creating organization and estate", user);
            });
          },
        },
      },
    },
  });

export type Auth = ReturnType<typeof getAuth>;
export type AuthSession = Awaited<ReturnType<Auth["api"]["getSession"]>>;
