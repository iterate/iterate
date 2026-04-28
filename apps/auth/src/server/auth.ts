import { admin } from "better-auth/plugins/admin";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth/minimal";
import { APIError } from "better-auth";
import { signJWT, verifyJWT } from "better-auth/crypto";
import { bearer, deviceAuthorization, emailOTP, jwt, oneTimeToken } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { organization } from "better-auth/plugins/organization";
import { matchesSignupAllowlist, parseSignupAllowlist } from "@iterate-com/shared/signup-allowlist";
import { generateDefaultAvatar } from "@iterate-com/shared/default-avatar";
import {
  ITERATE_ACTIVE_ORGANIZATION_ID_CLAIM,
  ITERATE_IS_ADMIN_CLAIM,
  ITERATE_ROLE_CLAIM,
} from "@iterate-com/shared/auth-claims";
import { env } from "./env.ts";
import { db, schema } from "./db/index.ts";

const TEST_EMAIL_PATTERN = /\+.*test@/i;
const TEST_OTP_CODE = "424242";
const isProduction = ["prd", "production", "prod"].includes(import.meta.env?.VITE_APP_STAGE);
const isNonProd = !isProduction;

export function getAllowedBrowserOrigins() {
  return [env.VITE_AUTH_APP_ORIGIN, env.VITE_PUBLIC_URL];
}

function isAllowedBrowserOrigin(origin: string | null | undefined) {
  if (!origin || !URL.canParse(origin)) return false;
  return getAllowedBrowserOrigins().includes(new URL(origin).origin);
}

function buildIterateTokenClaims(user: Record<string, unknown> | null | undefined) {
  const role = typeof user?.role === "string" ? user.role : null;
  return {
    [ITERATE_IS_ADMIN_CLAIM]: role === "admin",
    [ITERATE_ROLE_CLAIM]: role,
  };
}

async function getSessionActiveOrganizationId(jwt: Record<string, unknown> | null | undefined) {
  const sessionId = typeof jwt?.sid === "string" ? jwt.sid : null;
  if (!sessionId) return null;

  const authSession = await db.query.session.findFirst({
    where: (session, { eq }) => eq(session.id, sessionId),
    columns: { activeOrganizationId: true },
  });

  return authSession?.activeOrganizationId ?? null;
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
  trustedOrigins: (request) =>
    isAllowedBrowserOrigin(request?.headers.get("origin")) ? getAllowedBrowserOrigins() : [],
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
              if (isNonProd && TEST_EMAIL_PATTERN.test(email)) {
                return TEST_OTP_CODE;
              }
              return undefined;
            },
            sendVerificationOTP: async ({ email, otp }) => {
              if (isNonProd && TEST_EMAIL_PATTERN.test(email)) {
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
      customIdTokenClaims: ({ user }) => buildIterateTokenClaims(user),
      customAccessTokenClaims: ({ user }) => buildIterateTokenClaims(user),
      customUserInfoClaims: async ({ user, jwt }) => ({
        ...buildIterateTokenClaims(user),
        [ITERATE_ACTIVE_ORGANIZATION_ID_CLAIM]: await getSessionActiveOrganizationId(
          jwt as Record<string, unknown> | null | undefined,
        ),
      }),
      advertisedMetadata: {
        claims_supported: [
          ITERATE_IS_ADMIN_CLAIM,
          ITERATE_ROLE_CLAIM,
          ITERATE_ACTIVE_ORGANIZATION_ID_CLAIM,
        ],
      },
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
