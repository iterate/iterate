import { admin } from "better-auth/plugins/admin";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth/minimal";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { organization } from "better-auth/plugins/organization";
import { env } from "./env.ts";
import { db, schema } from "./db/index.ts";

export const auth = betterAuth({
  appName: "Iterate Auth",
  database: drizzleAdapter(db, { provider: "sqlite", schema }),
  baseURL: env.VITE_AUTH_APP_ORIGIN,
  trustedOrigins: [env.VITE_AUTH_APP_ORIGIN],
  secret: env.BETTER_AUTH_SECRET,
  plugins: [
    jwt(),
    admin(),
    organization(),
    oauthProvider({
      loginPage: "/login",
      consentPage: "/consent",
      silenceWarnings: { openidConfig: true, oauthAuthServerConfig: true },
      accessTokenExpiresIn: 5 * 60, // 5 minutes in seconds, since we are using jwt tokens
    }),
  ],
  socialProviders: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    },
  },
  disabledPaths: ["/token"],
  telemetry: { enabled: false },
  advanced: {
    ipAddress: {
      ipAddressHeaders: ["cf-connecting-ip"],
    },
  },
  session: {
    storeSessionInDatabase: true,
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60,
      strategy: "compact",
    },
  },
});

export type Auth = typeof auth;
export type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;
