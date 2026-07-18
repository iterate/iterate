import { z } from "zod/v4";
import {
  ITERATE_ACTIVE_ORGANIZATION_ID_CLAIM,
  ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM,
  ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM,
  ITERATE_IS_ADMIN_CLAIM,
  ITERATE_ORGANIZATIONS_CLAIM,
  IterateAuthAccessTokenOrganizationClaim,
  IterateAuthOrganizationClaim,
  IterateAuthProjectClaim,
  ITERATE_ROLE_CLAIM,
  type IterateAuthOrganizationClaim as IterateAuthOrganizationClaimType,
  type IterateAuthProjectClaim as IterateAuthProjectClaimType,
} from "@iterate-com/shared/auth-claims";

export const TokenSet = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.number(),
  idToken: z.string(),
  refreshToken: z.string().optional(),
  scope: z.string().optional(),
  tokenType: z.string(),
});

export type TokenSet = z.infer<typeof TokenSet>;

export const IdTokenClaims = z.looseObject({
  sub: z.string(),
  email: z.string(),
  name: z.string().optional(),
  picture: z.string().optional(),
  given_name: z.string().optional(),
  family_name: z.string().optional(),
  email_verified: z.boolean().optional(),
  iss: z.string(),
  aud: z.string(),
  iat: z.number(),
  exp: z.number(),
  [ITERATE_IS_ADMIN_CLAIM]: z.boolean().optional(),
  [ITERATE_ROLE_CLAIM]: z.string().nullable().optional(),
});

export const AccessTokenClaims = z.looseObject({
  sub: z.string(),
  email: z.string().optional(),
  scope: z.string(),
  scopes: z.array(z.string()).optional(),
  sid: z.string().optional(),
  azp: z.string().optional(),
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  iat: z.number(),
  exp: z.number(),
  [ITERATE_IS_ADMIN_CLAIM]: z.boolean().optional(),
  [ITERATE_ROLE_CLAIM]: z.string().nullable().optional(),
  [ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM]: z
    .array(IterateAuthAccessTokenOrganizationClaim)
    .optional(),
  [ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM]: z.array(IterateAuthProjectClaim).optional(),
});

export const UserInfoClaims = z.looseObject({
  sub: z.string(),
  [ITERATE_ACTIVE_ORGANIZATION_ID_CLAIM]: z.string().nullable().optional(),
  [ITERATE_ORGANIZATIONS_CLAIM]: z.array(IterateAuthOrganizationClaim).optional(),
});

export type IdTokenClaims = z.infer<typeof IdTokenClaims>;
export type AccessTokenClaims = z.infer<typeof AccessTokenClaims>;
export type UserInfoClaims = z.infer<typeof UserInfoClaims>;

export type AuthUser = {
  id: string;
  email: string;
  name?: string;
  picture?: string;
  givenName?: string;
  familyName?: string;
  emailVerified?: boolean;
  role?: string | null;
  isAdmin?: boolean;
};

export type AuthSession = {
  expiresAt: number;
  scope: string;
  sessionId?: string;
  activeOrganizationId?: string | null;
  organizations: IterateAuthOrganizationClaimType[];
  projects: IterateAuthProjectClaimType[];
};

export type AuthenticatedSession = {
  user: AuthUser;
  session: AuthSession;
  tokenClaims: {
    accessToken: AccessTokenClaims;
    idToken: IdTokenClaims;
  };
};

/** Credential-independent identity and grants proven by Iterate auth. */
export type AuthenticatedIdentity = {
  userId: string;
  sessionId?: string;
  email?: string;
  isAdmin: boolean;
  role: string | null;
  organizations: IterateAuthAccessTokenOrganizationClaim[];
  projects: IterateAuthProjectClaimType[];
};

export function identityFromSession(session: AuthenticatedSession): AuthenticatedIdentity {
  return {
    userId: session.user.id,
    sessionId: session.session.sessionId,
    email: session.user.email,
    isAdmin: session.user.isAdmin === true || session.user.role === "admin",
    role: session.user.role ?? null,
    organizations: session.session.organizations,
    projects: session.session.projects,
  };
}

export function identityFromAccessToken(accessToken: AccessTokenClaims): AuthenticatedIdentity {
  const role = accessToken[ITERATE_ROLE_CLAIM] ?? null;
  return {
    userId: accessToken.sub,
    sessionId: accessToken.sid,
    email: accessToken.email,
    isAdmin: accessToken[ITERATE_IS_ADMIN_CLAIM] === true || role === "admin",
    role,
    organizations: accessToken[ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM] ?? [],
    projects: accessToken[ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM] ?? [],
  };
}

export function buildAuthenticatedSession(
  accessToken: AccessTokenClaims,
  idToken: IdTokenClaims,
  userInfo: UserInfoClaims | null,
): AuthenticatedSession {
  const accessTokenOrganizations =
    accessToken[ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM]?.map((organization) => ({
      ...organization,
      name:
        userInfo?.[ITERATE_ORGANIZATIONS_CLAIM]?.find(
          (userInfoOrganization) => userInfoOrganization.id === organization.id,
        )?.name ??
        organization.name ??
        organization.slug,
    })) ?? null;

  return {
    user: {
      id: idToken.sub,
      email: idToken.email,
      name: idToken.name,
      picture: idToken.picture,
      givenName: idToken.given_name,
      familyName: idToken.family_name,
      emailVerified: idToken.email_verified,
      role: idToken[ITERATE_ROLE_CLAIM] ?? null,
      isAdmin: idToken[ITERATE_IS_ADMIN_CLAIM] ?? false,
    },
    session: {
      expiresAt: accessToken.exp,
      scope: accessToken.scope,
      sessionId: accessToken.sid,
      activeOrganizationId: userInfo?.[ITERATE_ACTIVE_ORGANIZATION_ID_CLAIM] ?? null,
      organizations: accessTokenOrganizations ?? userInfo?.[ITERATE_ORGANIZATIONS_CLAIM] ?? [],
      projects: accessToken[ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM] ?? [],
    },
    tokenClaims: { accessToken, idToken },
  };
}

export type SessionResponse =
  | { authenticated: false }
  | ({ authenticated: true } & AuthenticatedSession);
