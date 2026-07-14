import { InternalIntrospectOAuthAccessTokenInput } from "@iterate-com/auth-contract";
import type { OAuthAccessTokenIntrospectionResult } from "@iterate-com/auth-contract/worker";
import { parseStringArray } from "./db/helpers.ts";
import type { DB } from "./db/index.ts";
import { getOAuthAccessTokenForInternalIntrospection } from "./db/queries/index.ts";
import {
  buildAccessTokenGrantClaims,
  parseOAuthProjectSelectionReferenceId,
} from "./oauth-project-selection.ts";
import { hashOAuthStoredValue } from "./oauth-storage.ts";
import { isPlatformAdminUser } from "./platform-admin.ts";

function toMillis(value: number | string | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Private opaque-token introspection for OS's MCP resource server. */
export async function introspectAccessToken(params: {
  input: InternalIntrospectOAuthAccessTokenInput;
  client: DB;
  issuer: string;
}): Promise<OAuthAccessTokenIntrospectionResult> {
  const input = InternalIntrospectOAuthAccessTokenInput.parse(params.input);
  const token = await getOAuthAccessTokenForInternalIntrospection(params.client, {
    token: await hashOAuthStoredValue(input.token),
  });
  if (!token) return { active: false, reason: "not_found" };

  const expiresAtMs = toMillis(token.expiresAt);
  if (!expiresAtMs || expiresAtMs <= Date.now()) {
    return { active: false, reason: "expired" };
  }
  if (token.clientDisabled === 1) {
    return { active: false, reason: "client_disabled" };
  }
  if (!token.userId) {
    return { active: false, reason: "missing_user" };
  }

  // A token whose session row was deleted stays active until its own expiry,
  // matching better-auth and JWT access-token behavior. A present but expired
  // session is rejected more strictly.
  if (token.sessionId) {
    const sessionExpiresAtMs = toMillis(token.sessionExpiresAt);
    if (!sessionExpiresAtMs || sessionExpiresAtMs <= Date.now()) {
      return { active: false, reason: "session_expired" };
    }
  }

  const grants = await buildAccessTokenGrantClaims(
    {
      userId: token.userId,
      requestedScopes: parseStringArray(token.scopes),
      selection: parseOAuthProjectSelectionReferenceId(token.referenceId),
    },
    params.client,
  );
  const role = token.userRole ?? null;

  return {
    active: true,
    sub: token.userId,
    sid: token.sessionId ?? undefined,
    clientId: token.clientId,
    iss: params.issuer,
    aud: input.audiences,
    iat: Math.floor((toMillis(token.createdAt) ?? Date.now()) / 1000),
    exp: Math.floor(expiresAtMs / 1000),
    scope: grants.scopes.join(" "),
    scopes: grants.scopes,
    organizations: grants.organizations,
    projects: grants.projects,
    isAdmin: isPlatformAdminUser({ role }),
    role,
  };
}
