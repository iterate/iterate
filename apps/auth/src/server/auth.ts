import { betterAuth } from "better-auth/minimal";
import { APIError } from "better-auth";
import { signJWT, verifyJWT } from "better-auth/crypto";
import { matchesSignupAllowlist, parseSignupAllowlist } from "@iterate-com/shared/signup-allowlist";
import { generateDefaultAvatar } from "@iterate-com/shared/default-avatar";
import { env } from "./env.ts";
import { getAuthPlugins } from "./auth-plugins.ts";

export function getAllowedBrowserOrigins() {
  return [env.VITE_AUTH_APP_ORIGIN, env.VITE_PUBLIC_URL];
}

function isAllowedBrowserOrigin(origin: string | null | undefined) {
  if (!origin || !URL.canParse(origin)) return false;
  return getAllowedBrowserOrigins().includes(new URL(origin).origin);
}

export type ProjectIngressTokenPayload = {
  type: "project-ingress";
  userId: string;
  email: string;
  role: string | null;
};

export async function createProjectIngressToken(payload: ProjectIngressTokenPayload) {
  return signJWT(payload, env.BETTER_AUTH_SECRET, 60 * 60);
}

export async function verifyProjectIngressToken(token: string) {
  const payload = await verifyJWT<ProjectIngressTokenPayload>(token, env.BETTER_AUTH_SECRET);
  if (!payload || payload.type !== "project-ingress" || !payload.userId || !payload.email) {
    return null;
  }
  return payload;
}

export const auth = betterAuth({
  appName: "Iterate Auth",
  database: env.DB,
  baseURL: env.VITE_AUTH_APP_ORIGIN,
  plugins: getAuthPlugins(env),
  trustedOrigins: (request) =>
    isAllowedBrowserOrigin(request?.headers.get("origin")) ? getAllowedBrowserOrigins() : [],
  secret: env.BETTER_AUTH_SECRET,
  session: {
    storeSessionInDatabase: true,
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60,
      strategy: "compact",
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const email = user.email.trim().toLowerCase();
          const allowlist = parseSignupAllowlist(env.SIGNUP_ALLOWLIST);
          if (!matchesSignupAllowlist(email, allowlist)) {
            throw new APIError("FORBIDDEN", {
              message: "Sign up is not available for this email address",
            });
          }

          return {
            data: {
              ...user,
              image: user.image || generateDefaultAvatar(email),
            },
          };
        },
      },
    },
  },

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
});

export type Auth = typeof auth;
export type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;
