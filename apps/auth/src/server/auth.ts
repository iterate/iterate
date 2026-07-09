import { betterAuth } from "better-auth";
import { APIError } from "better-auth";
import { signJWT, verifyJWT } from "better-auth/crypto";
import { matchesSignupAllowlist, parseSignupAllowlist } from "@iterate-com/shared/signup-allowlist";
import { generateDefaultAvatar } from "@iterate-com/shared/default-avatar";
import { config, env } from "./env.ts";
import { getAuthPlugins } from "./auth-plugins.ts";
import { db } from "./db/index.ts";
import { ensureIterateOrganizationMembershipForNustomUserId } from "./organization-auto-join.ts";

const LOCAL_OAUTH_CLIENT_ORIGINS = [
  "http://localhost:6274",
  "http://127.0.0.1:6274",
  "http://[::1]:6274",
] as const;

export function getAllowedBrowserOrigins(): string[] {
  // config.authAppOrigin/publicUrl are `publicValue`-tagged strings; a tagged
  // string is assignable to `string`, so collect them into a plain `string[]`
  // (dropping an unset publicUrl) for comparing/`Set`ing against request origins.
  const origins: string[] = [config.authAppOrigin, ...LOCAL_OAUTH_CLIENT_ORIGINS];
  if (config.publicUrl) origins.push(config.publicUrl);
  return origins;
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
  return signJWT(payload, config.betterAuthSecret.exposeSecret(), 60 * 60);
}

export async function verifyProjectIngressToken(token: string) {
  const payload = await verifyJWT<ProjectIngressTokenPayload>(
    token,
    config.betterAuthSecret.exposeSecret(),
  );
  if (!payload || payload.type !== "project-ingress" || !payload.userId || !payload.email) {
    return null;
  }
  return payload;
}

export const auth = betterAuth({
  appName: "Iterate Auth",
  database: env.DB,
  baseURL: config.authAppOrigin,
  plugins: getAuthPlugins({
    emailOtpEnabled: config.emailOtpEnabled,
    emailBinding: env.EMAIL,
    emailSenderDomain: config.emailSenderDomain,
  }),
  trustedOrigins: (request) =>
    isAllowedBrowserOrigin(request?.headers.get("origin")) ? getAllowedBrowserOrigins() : [],
  secret: config.betterAuthSecret.exposeSecret(),
  session: {
    storeSessionInDatabase: true,
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60,
      strategy: "compact",
    },
  },
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const email = user.email.trim().toLowerCase();
          const allowlist = parseSignupAllowlist(config.signupAllowlist);
          if (!matchesSignupAllowlist(email, allowlist)) {
            throw new APIError("FORBIDDEN", {
              message: "Sign up is not available for this email address",
            });
          }

          // Email-domain promotion relies on the two sign-in methods (Google,
          // email OTP) proving mailbox ownership before this hook runs —
          // password signup is disabled. Deliberate exception: `*+test@nustom.com`
          // addresses accept the fixed test OTP in every stage, including
          // production (see shouldUseTestOtp), so the test code effectively
          // mints platform-admin accounts. Accepted risk for headless testing.
          const platformAdminAllowlist = parseSignupAllowlist(config.adminAllowlist);
          const isPlatformAdmin = matchesSignupAllowlist(email, platformAdminAllowlist);

          return {
            data: {
              ...user,
              role: isPlatformAdmin ? "admin" : user.role,
              image: user.image || generateDefaultAvatar(email),
            },
          };
        },
      },
    },
    session: {
      create: {
        after: async (session) => {
          await ensureIterateOrganizationMembershipForNustomUserId(db, session.userId);
        },
      },
    },
  },

  socialProviders: {
    google: {
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret.exposeSecret(),
      prompt: "select_account",
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
