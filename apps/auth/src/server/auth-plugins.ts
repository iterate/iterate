import { admin } from "better-auth/plugins/admin";
import { bearer, deviceAuthorization, emailOTP, jwt, oneTimeToken } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { organization } from "better-auth/plugins/organization";
import {
  ITERATE_ACTIVE_ORGANIZATION_ID_CLAIM,
  ITERATE_IS_ADMIN_CLAIM,
  ITERATE_ROLE_CLAIM,
} from "@iterate-com/shared/auth-claims";
import { betterAuth } from "better-auth";
import { getSessionActiveOrganizationIdById } from "./db/queries/.generated/index.ts";
import { db } from "./db/index.ts";

const TEST_EMAIL_PATTERN = /\+.*test@/i;
const TEST_OTP_CODE = "424242";
const isProduction = ["prd", "production", "prod"].includes(import.meta.env?.VITE_APP_STAGE);
const isNonProd = !isProduction;

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

  const authSession = await getSessionActiveOrganizationIdById(db, { id: sessionId });
  return authSession?.activeOrganizationId ?? null;
}

export function getAuthPlugins(env: Record<string, unknown>) {
  return [
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
  ] satisfies Parameters<typeof betterAuth>[0]["plugins"];
}
