import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { type DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { env } from "../../env.ts";

export const getAuth = (db: DB) =>
  betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema,
    }),
    socialProviders: {
      google: {
        scopes: [
          "https://www.googleapis.com/auth/userinfo.email",
          "https://www.googleapis.com/auth/userinfo.profile",
          "openid",
        ],
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },
  });

export type Auth = ReturnType<typeof getAuth>;
export type AuthSession = Awaited<ReturnType<Auth["api"]["getSession"]>>;
