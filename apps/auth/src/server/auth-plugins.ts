import { admin } from "better-auth/plugins/admin";
import { bearer, deviceAuthorization, emailOTP, jwt, oneTimeToken } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { organization } from "better-auth/plugins/organization";
import {
  ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM,
  ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM,
  ITERATE_PROJECT_SELECTION_SCOPE,
  ITERATE_ACTIVE_ORGANIZATION_ID_CLAIM,
  ITERATE_IS_ADMIN_CLAIM,
  ITERATE_ORGANIZATIONS_CLAIM,
  ITERATE_ROLE_CLAIM,
} from "@iterate-com/shared/auth-claims";
import { betterAuth } from "better-auth";
import {
  getSessionActiveOrganizationIdById,
  listOrganizationsForUser,
} from "./db/queries/.generated/index.ts";
import { db } from "./db/index.ts";
import {
  buildAccessTokenGrantClaims,
  buildOAuthProjectSelectionReferenceId,
  listOrganizationClaimsForUser,
  parseOAuthProjectSelectionReferenceId,
  resolveStoredProjectSelection,
} from "./oauth-project-selection.ts";
import { getOsMcpResourceBases, getOsResourceBases } from "./oauth-resources.ts";
import { isPlatformAdminUser } from "./platform-admin.ts";

const TEST_EMAIL_PATTERN = /\+.*test@/i;
const TEST_OTP_CODE = "424242";
const isProduction = ["prd", "production", "prod"].includes(import.meta.env?.VITE_APP_STAGE);
const isNonProd = !isProduction;

// Custom claims go out on three surfaces, configured further down in
// oauthProvider():
// - access tokens (customAccessTokenClaims): what resource servers like OS
//   authorize against — org/project claims, project:<id> scope entries, and
//   the Better Auth admin-plugin role claim.
// - ID tokens (customIdTokenClaims) and userinfo (customUserInfoClaims):
//   login-time identity for the relying party — the namespaced
//   https://iterate.com/claims/* values built here.
function buildIterateTokenClaims(user: Record<string, unknown> | null | undefined) {
  const role = typeof user?.role === "string" ? user.role : null;
  return {
    [ITERATE_IS_ADMIN_CLAIM]: isPlatformAdminUser({ role }),
    [ITERATE_ROLE_CLAIM]: role,
  };
}

async function getSessionActiveOrganizationId(jwt: Record<string, unknown> | null | undefined) {
  const sessionId = typeof jwt?.sid === "string" ? jwt.sid : null;
  if (!sessionId) return null;

  const authSession = await getSessionActiveOrganizationIdById(db, { id: sessionId });
  return authSession?.activeOrganizationId ?? null;
}

// better-auth hands its user object to plugin hooks as a loose record.
function userIdOf(user: Record<string, unknown> | null | undefined): string | null {
  return typeof user?.id === "string" ? user.id : null;
}

export function getAuthPlugins(env: Record<string, unknown>) {
  const osResourceBases = getOsResourceBases();
  const validAudiences = [...osResourceBases, ...getOsMcpResourceBases()];

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
      postLogin: {
        page: "/project-access",
        shouldRedirect: async ({ scopes, session }) => {
          if (session?.userId) {
            const organizations = await listOrganizationsForUser(db, { userId: session.userId });
            if (organizations.length === 0) {
              return true;
            }
          }

          if (!scopes.includes(ITERATE_PROJECT_SELECTION_SCOPE)) {
            return false;
          }

          const selection = await resolveStoredProjectSelection({ sessionId: session?.id });

          return !selection;
        },
        consentReferenceId: async ({ session }) => {
          const selection = await resolveStoredProjectSelection({ sessionId: session?.id });
          if (!selection || !session?.userId) {
            return undefined;
          }

          return buildOAuthProjectSelectionReferenceId({
            projectIds: selection,
            userId: session.userId,
          });
        },
      },
      silenceWarnings: { openidConfig: true, oauthAuthServerConfig: true },
      // Long enough that refresh (which rotates the refresh token and treats
      // rotated-token reuse as theft) is rare, short enough that org/project
      // claim changes propagate within half an hour.
      accessTokenExpiresIn: 30 * 60,
      scopes: ["openid", "profile", "email", "offline_access", ITERATE_PROJECT_SELECTION_SCOPE],
      validAudiences,
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      customAccessTokenClaims: async ({ user, referenceId, scopes }) => {
        const grants = await buildAccessTokenGrantClaims({
          userId: userIdOf(user),
          requestedScopes: scopes,
          selection: parseOAuthProjectSelectionReferenceId(referenceId),
        });

        return {
          ...buildIterateTokenClaims(user),
          scopes: grants.scopes,
          [ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM]: grants.organizations,
          [ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM]: grants.projects,
        };
      },
      customIdTokenClaims: ({ user }) => buildIterateTokenClaims(user),
      customUserInfoClaims: async ({ user, jwt }) => {
        const [organizationClaims, activeOrganizationId] = await Promise.all([
          listOrganizationClaimsForUser(userIdOf(user)),
          getSessionActiveOrganizationId(jwt as Record<string, unknown> | null | undefined),
        ]);
        return {
          ...buildIterateTokenClaims(user),
          [ITERATE_ORGANIZATIONS_CLAIM]: organizationClaims,
          [ITERATE_ACTIVE_ORGANIZATION_ID_CLAIM]: activeOrganizationId,
        };
      },
      advertisedMetadata: {
        claims_supported: [
          ITERATE_IS_ADMIN_CLAIM,
          ITERATE_ROLE_CLAIM,
          ITERATE_ACTIVE_ORGANIZATION_ID_CLAIM,
          ITERATE_ORGANIZATIONS_CLAIM,
        ],
      },
    }),
  ] satisfies Parameters<typeof betterAuth>[0]["plugins"];
}
