import { describe, expect, it } from "vitest";
import type { AccessTokenClaims, AuthenticatedSession } from "@iterate-com/auth/server";
import { ITERATE_IS_ADMIN_CLAIM, ITERATE_ROLE_CLAIM } from "@iterate-com/shared/auth-claims";
import {
  createUserPrincipal,
  principalFromAccessToken,
  principalFromSession,
  principalIsAdmin,
} from "./principal.ts";

describe("auth principal admin access", () => {
  it("identifies Better Auth admin browser sessions as admin", () => {
    const principal = principalFromSession({
      session: {
        activeOrganizationId: null,
        expiresAt: 4_102_444_800,
        organizations: [],
        projects: [],
        scope: "openid profile",
        sessionId: "sess_1",
      },
      tokenClaims: {} as AuthenticatedSession["tokenClaims"],
      user: {
        email: "jonas@nustom.com",
        id: "usr_jonas",
        isAdmin: true,
        role: "admin",
      },
    });

    expect(principal.isAdmin).toBe(true);
    expect(principalIsAdmin(principal)).toBe(true);
  });

  it("identifies Better Auth admin bearer access tokens as admin", () => {
    const principal = principalFromAccessToken({
      aud: "https://os.iterate.com",
      exp: 4_102_444_800,
      iat: 1_700_000_000,
      iss: "https://auth.iterate.com",
      scope: "project",
      sub: "usr_jonas",
      [ITERATE_IS_ADMIN_CLAIM]: true,
      [ITERATE_ROLE_CLAIM]: "admin",
    } as AccessTokenClaims);

    expect(principal.isAdmin).toBe(true);
    expect(principalIsAdmin(principal)).toBe(true);
  });

  it("does not identify ordinary users as admin", () => {
    const principal = createUserPrincipal({
      organizations: [],
      projects: [],
      userId: "usr_member",
    });

    expect(principalIsAdmin(principal)).toBe(false);
  });
});
