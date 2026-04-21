import { admin } from "better-auth/plugins/admin";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth/minimal";
import { APIError } from "better-auth";
import { signJWT, verifyJWT } from "better-auth/crypto";
import { bearer, deviceAuthorization, emailOTP, jwt, oneTimeToken } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { organization } from "better-auth/plugins/organization";
import { matchesSignupAllowlist, parseSignupAllowlist } from "@iterate-com/shared/signup-allowlist";
import { env } from "./env.ts";
import { db, schema } from "./db/index.ts";

const TEST_EMAIL_PATTERN = /\+.*test@/i;
const TEST_OTP_CODE = "424242";

export function generateDefaultAvatar(email: string): string {
  const normalized = email.trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash << 5) - hash + normalized.charCodeAt(i);
    hash |= 0;
  }
  return `https://api.dicebear.com/9.x/notionists/svg?seed=${Math.abs(hash).toString(36)}`;
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
  database: drizzleAdapter(db, { provider: "sqlite", schema }),
  baseURL: env.VITE_AUTH_APP_ORIGIN,
  trustedOrigins: (request) => {
    const requestOrigin = request?.headers.get("origin");
    const origins = [env.VITE_AUTH_APP_ORIGIN];
    if (requestOrigin && URL.canParse(requestOrigin)) {
      origins.push(requestOrigin);
    }
    return origins;
  },
  secret: env.BETTER_AUTH_SECRET,
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
  plugins: [
    jwt(),
    bearer(),
    admin(),
    organization(),
    deviceAuthorization({
      verificationUri: "/device",
      expiresIn: "15m",
      interval: "5s",
      userCodeLength: 8,
      deviceCodeLength: 40,
      validateClient: async (clientId) => clientId === "iterate-cli",
    }),
    oneTimeToken({
      disableClientRequest: true,
      storeToken: "plain",
      disableSetSessionCookie: true,
    }),
    ...(env.VITE_ENABLE_EMAIL_OTP_SIGNIN === "true"
      ? [
          emailOTP({
            otpLength: 6,
            expiresIn: 300,
            generateOTP: ({ email }) => {
              if (TEST_EMAIL_PATTERN.test(email)) {
                return TEST_OTP_CODE;
              }
              return undefined;
            },
            sendVerificationOTP: async ({ email, otp }) => {
              if (TEST_EMAIL_PATTERN.test(email)) {
                return;
              }

              const response = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: {
                  authorization: `Bearer ${env.RESEND_BOT_API_KEY}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  from: `Iterate <noreply+auth@${env.RESEND_BOT_DOMAIN}>`,
                  to: email,
                  subject: `Your verification code: ${otp}`,
                  text: `Your verification code is: ${otp}\n\nThis code expires in 5 minutes.`,
                }),
              });

              if (!response.ok) {
                throw new Error(`Failed to send verification email: ${response.status}`);
              }
            },
          }),
        ]
      : []),
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
