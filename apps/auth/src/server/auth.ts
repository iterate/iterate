import { betterAuth } from "better-auth";
import { APIError } from "better-auth";
import { signJWT, verifyJWT } from "better-auth/crypto";
import { matchesSignupAllowlist, parseSignupAllowlist } from "@iterate-com/shared/signup-allowlist";
import { generateDefaultAvatar } from "@iterate-com/shared/default-avatar";
import { config, env } from "./env.ts";
import { getAuthPlugins } from "./auth-plugins.ts";
import { authJwt } from "./auth-jwt.ts";

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

export function isAllowedBrowserOrigin(origin: string | null | undefined) {
  if (!origin || !URL.canParse(origin)) return false;
  const url = new URL(origin);
  // Loopback web clients on ARBITRARY ports — the Expo Web mobile app that
  // playwright specs and local dev drive (its port is random per run; the
  // fixed-port MCP-inspector entries above predate this). Browser-side OAuth
  // (discovery, dynamic registration, token exchange) needs CORS, which
  // native apps never do. Gated on the test-automation flag so production
  // auth never trusts localhost pages.
  if (
    config.fixedTestOtpEnabled &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    return true;
  }
  return getAllowedBrowserOrigins().includes(url.origin);
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
    authAppOrigin: config.authAppOrigin,
    jwtPlugin: authJwt(config.authSigningPrivateJwk.exposeSecret()),
    emailOtpEnabled: config.emailOtpEnabled,
    fixedTestOtpEnabled: config.fixedTestOtpEnabled,
    emailBinding: env.EMAIL,
    emailSenderDomain: config.emailSenderDomain,
  }),
  trustedOrigins: (request) => {
    const origin = request?.headers.get("origin");
    if (!isAllowedBrowserOrigin(origin)) return [];
    // Include the requesting origin itself: loopback web clients pass the
    // predicate on shape, not by membership in the static list.
    return [...getAllowedBrowserOrigins(), new URL(origin!).origin];
  },
  secret: config.betterAuthSecret.exposeSecret(),
  session: {
    storeSessionInDatabase: true,
    // A LONG rolling session: any authenticated touch within `updateAge`
    // granularity extends it, so interactive login is needed only after 60
    // days of complete inactivity. The 60-day floor is deliberate: relying
    // parties' refresh-token chains hit their hard ~30-day ceiling and
    // bounce back through /authorize — with this session still alive, that
    // bounce is a silent redirect instead of a Google login. (Before this,
    // the 7-day default was almost always dead by the time a bounce
    // happened, forcing a full re-login roughly every token ceiling.)
    expiresIn: 60 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
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
          // password signup is disabled. Non-production `*+test@nustom.com`
          // addresses are the deliberate exception for headless testing
          // (see shouldUseTestOtp).
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
