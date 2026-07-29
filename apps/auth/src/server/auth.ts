import { betterAuth } from "better-auth";
import { APIError } from "better-auth";
import { signJWT, verifyJWT } from "better-auth/crypto";
import { matchesSignupAllowlist, parseSignupAllowlist } from "@iterate-com/shared/signup-allowlist";
import { generateDefaultAvatar } from "@iterate-com/shared/default-avatar";
import { config, env } from "./env.ts";
import { getAuthPlugins } from "./auth-plugins.ts";
import { authJwt } from "./auth-jwt.ts";

/**
 * THE browser-origin trust decision, in one place. Loopback origins: on
 * test-automation stages (fixedTestOtpEnabled — local/dev/preview, never
 * production) ANY loopback port is trusted, because the Expo Web mobile app's
 * browser-side OAuth (discovery, dynamic registration, token exchange —
 * native apps never hit CORS) runs on a random port per invocation;
 * production trusts only the MCP inspector's fixed port 6274. Everything
 * else must BE this deployment: the auth app origin, or its public alias.
 */
export function isAllowedBrowserOrigin(origin: string | null | undefined) {
  if (!origin || !URL.canParse(origin)) return false;
  const url = new URL(origin);
  const isLoopback =
    url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (isLoopback) return config.fixedTestOtpEnabled || url.port === "6274";
  return url.origin === config.authAppOrigin || url.origin === config.publicUrl;
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
    // The allowed requester plus this deployment's own origins — loopback
    // clients pass the predicate on shape, so the requester must be listed
    // explicitly.
    const trusted: string[] = [new URL(origin!).origin, config.authAppOrigin];
    if (config.publicUrl) trusted.push(config.publicUrl);
    return trusted;
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
