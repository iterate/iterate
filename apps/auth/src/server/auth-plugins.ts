import { admin } from "better-auth/plugins/admin";
import {
  bearer,
  deviceAuthorization,
  emailOTP,
  multiSession,
  oneTimeToken,
} from "better-auth/plugins";
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
import { APIError, betterAuth } from "better-auth";
import {
  getSessionActiveOrganizationIdById,
  listOrganizationsForUser,
  updateInviteStatusById,
} from "./db/queries/.generated/index.ts";
import { db } from "./db/index.ts";
import {
  buildAccessTokenGrantClaims,
  buildOAuthProjectSelectionReferenceId,
  listOrganizationClaimsForUser,
  parseOAuthProjectSelectionReferenceId,
  resolveStoredProjectSelection,
} from "./oauth-project-selection.ts";
import {
  getOsMcpResourceBases,
  getOsResourceBases,
  getSemaphoreResourceBases,
  getStreamsExampleResourceBases,
} from "./oauth-resources.ts";
import { isPlatformAdminUser } from "./platform-admin.ts";
import {
  type CloudflareEmailBinding,
  TEST_OTP_CODE,
  getOrganizationInvitationEmailConfigError,
  sendEmailOtp,
  sendOrganizationInvitationEmail,
  shouldUseTestOtp,
} from "./email.ts";
import type { AuthJwtPlugin } from "./auth-jwt.ts";

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

const iterateOrganizationRoles = new Set(["member", "admin", "owner"]);

function normalizeSingleOrganizationRole(role: string) {
  const normalized = role.trim();
  if (!iterateOrganizationRoles.has(normalized)) {
    throw new APIError("BAD_REQUEST", {
      message: "Organization role must be one of member, admin, or owner",
    });
  }
  return normalized;
}

/** Only the config the plugin list actually needs. Kept plain (not the whole
 * `AppConfig`) so the sqlfu schema-generation entry (auth.schema-only.ts) can
 * build the same plugin set without real secrets. */
export type AuthPluginOptions = {
  authAppOrigin: string;
  jwtPlugin: AuthJwtPlugin;
  emailOtpEnabled: boolean;
  fixedTestOtpEnabled: boolean;
  emailBinding: CloudflareEmailBinding | undefined;
  emailSenderDomain: string;
};

export function getAuthPlugins(options: AuthPluginOptions) {
  const osResourceBases = getOsResourceBases();
  const validAudiences = [
    ...osResourceBases,
    ...getSemaphoreResourceBases(),
    ...getStreamsExampleResourceBases(),
    ...getOsMcpResourceBases(),
  ];

  return [
    options.jwtPlugin,
    bearer(),
    admin(),
    organization({
      // Better Auth's `sendInvitationEmail` callback is routed through
      // runInBackgroundOrAwait, which logs delivery failures instead of failing
      // inviteMember. Hooks keep delivery on the endpoint path while still
      // using the native organization invitation lifecycle.
      organizationHooks: {
        beforeAddMember: async (data) => ({
          data: {
            ...data.member,
            role: normalizeSingleOrganizationRole(data.member.role),
          },
        }),
        beforeCreateInvitation: async (data) => {
          const configError = getOrganizationInvitationEmailConfigError({
            senderDomain: options.emailSenderDomain,
            emailBinding: options.emailBinding,
          });
          if (configError) {
            throw new APIError("INTERNAL_SERVER_ERROR", { message: configError });
          }

          return {
            data: {
              ...data.invitation,
              role: normalizeSingleOrganizationRole(data.invitation.role),
            },
          };
        },
        beforeAcceptInvitation: async (data) => {
          normalizeSingleOrganizationRole(data.invitation.role);
        },
        beforeUpdateMemberRole: async (data) => {
          return {
            data: {
              role: normalizeSingleOrganizationRole(data.newRole),
            },
          };
        },
        afterCreateInvitation: async (data) => {
          const invitationUrl = new URL(
            `/invitations/${data.invitation.id}`,
            options.authAppOrigin,
          );

          try {
            await sendOrganizationInvitationEmail({
              email: data.invitation.email,
              role: data.invitation.role,
              organizationName: data.organization.name,
              inviterName: data.inviter.name,
              inviterEmail: data.inviter.email,
              invitationUrl: invitationUrl.toString(),
              senderDomain: options.emailSenderDomain,
              emailBinding: options.emailBinding,
            });
          } catch (error) {
            await updateInviteStatusById(db, { status: "canceled" }, { id: data.invitation.id });
            throw error;
          }
        },
      },
    }),
    multiSession({ maximumSessions: 10 }),
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
    ...(options.emailOtpEnabled
      ? [
          emailOTP({
            otpLength: 6,
            expiresIn: 300,
            generateOTP: ({ email }) => {
              if (shouldUseTestOtp({ email, fixedTestOtpEnabled: options.fixedTestOtpEnabled })) {
                return TEST_OTP_CODE;
              }
              return undefined;
            },
            sendVerificationOTP: async ({ email, otp }) => {
              if (shouldUseTestOtp({ email, fixedTestOtpEnabled: options.fixedTestOtpEnabled })) {
                return;
              }

              await sendEmailOtp({
                email,
                otp,
                senderDomain: options.emailSenderDomain,
                emailBinding: options.emailBinding,
              });
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

          // Always collect a fresh selection: better-auth evaluates
          // shouldRedirect once per authorizeEndpoint pass, but only when the
          // caller does NOT set the `postLogin` settings flag. The `continue`
          // (project-access submit) handler sets it; the `consent` handler
          // upstream does NOT — it writes a dead `ctx.context.postLogin` that
          // authorizeEndpoint never reads — so accepting consent re-enters
          // authorize and shows /project-access a SECOND time. Our patch
          // (patches/@better-auth__oauth-provider@1.6.9.patch) makes the
          // consent re-entry pass `{ postLogin: true }` like continue does, so
          // this now shows /project-access exactly once per authorization —
          // and guarantees the selection consentReferenceId consumes is the one
          // THIS flow just collected, never a leftover from another client in
          // the same browser session.
          return scopes.includes(ITERATE_PROJECT_SELECTION_SCOPE);
        },
        consentReferenceId: async ({ session }) => {
          const selection = await resolveStoredProjectSelection({
            sessionId: session?.id,
            client: db,
          });
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
        const grants = await buildAccessTokenGrantClaims(
          {
            userId: userIdOf(user),
            requestedScopes: scopes,
            selection: parseOAuthProjectSelectionReferenceId(referenceId),
          },
          db,
        );

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
          listOrganizationClaimsForUser(userIdOf(user), db),
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
