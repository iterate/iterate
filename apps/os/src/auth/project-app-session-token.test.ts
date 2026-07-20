import { describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import {
  localProjectAppSessionValidator,
  verifyProjectAppSessionToken,
} from "./project-app-session-token.ts";

const SECRET = "test-project-app-session-secret";

/** Sign exactly the way the auth worker does (better-auth signJWT = jose HS256). */
async function sign(
  claims: Record<string, unknown>,
  options: { secret?: string; expiresInSeconds?: number } = {},
): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + (options.expiresInSeconds ?? 900))
    .sign(new TextEncoder().encode(options.secret ?? SECRET));
}

const CLAIMS = {
  audience: "https://tasks--demo.iterate.app",
  projectId: "prj_one",
  type: "project-app-session",
  userId: "usr_1",
};

describe("verifyProjectAppSessionToken", () => {
  it("answers the claims for a well-signed unexpired token", async () => {
    const token = await sign(CLAIMS);
    const claims = await verifyProjectAppSessionToken(token, SECRET);
    expect(claims).toMatchObject({ projectId: "prj_one", userId: "usr_1" });
  });

  it("refuses the wrong secret, expiry, wrong claim shape, and malformed tokens", async () => {
    expect(await verifyProjectAppSessionToken(await sign(CLAIMS, { secret: "other" }), SECRET)) //
      .toBeNull();
    expect(
      await verifyProjectAppSessionToken(await sign(CLAIMS, { expiresInSeconds: -5 }), SECRET),
    ).toBeNull();
    expect(
      await verifyProjectAppSessionToken(await sign({ ...CLAIMS, type: "other-token" }), SECRET),
    ).toBeNull();
    expect(await verifyProjectAppSessionToken("not-a-jwt", SECRET)).toBeNull();
    expect(await verifyProjectAppSessionToken("a.b", SECRET)).toBeNull();
    expect(await verifyProjectAppSessionToken("", SECRET)).toBeNull();
    // A tampered payload fails the signature even though both halves decode.
    const token = await sign(CLAIMS);
    const [header, , signature] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...CLAIMS, userId: "usr_evil", exp: Math.floor(Date.now() / 1000) + 900 }),
    ).toString("base64url");
    expect(
      await verifyProjectAppSessionToken(`${header}.${forgedPayload}.${signature}`, SECRET),
    ).toBeNull();
  });

  it("refuses a token whose header names a different algorithm", async () => {
    // alg confusion probe: an unsigned token claiming "none" must not pass.
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ ...CLAIMS, exp: Math.floor(Date.now() / 1000) + 900 }),
    ).toString("base64url");
    expect(await verifyProjectAppSessionToken(`${header}.${payload}.`, SECRET)).toBeNull();
  });
});

describe("localProjectAppSessionValidator", () => {
  it("matches the auth worker's validate contract: audience and project must bind", async () => {
    const validate = localProjectAppSessionValidator(SECRET, async () => null);
    const token = await sign(CLAIMS);

    const valid = await validate({
      audience: CLAIMS.audience,
      projectId: CLAIMS.projectId,
      token,
    });
    expect(valid).toMatchObject({ userId: "usr_1" });
    expect(valid!.expiresAt).toBeGreaterThan(Date.now() / 1000);

    expect(
      await validate({
        audience: "https://other--app.iterate.app",
        projectId: CLAIMS.projectId,
        token,
      }),
    ).toBeNull();
    expect(await validate({ audience: CLAIMS.audience, projectId: "prj_other", token })).toBeNull();
  });

  it("falls back to the auth worker only when the local signature check refuses", async () => {
    // A legacy-signed token: local verify refuses, the RPC (which knows the
    // old secret) answers — the rotation window. A bound-but-wrong audience
    // on a VALID signature is a plain refusal, never a fallback.
    const legacyToken = await sign(CLAIMS, { secret: "previous-secret" });
    const fallback = vi.fn().mockResolvedValue({ expiresAt: 123, userId: "usr_legacy" });
    const validate = localProjectAppSessionValidator(SECRET, fallback);

    const legacy = await validate({
      audience: CLAIMS.audience,
      projectId: CLAIMS.projectId,
      token: legacyToken,
    });
    expect(legacy).toMatchObject({ userId: "usr_legacy" });
    expect(fallback).toHaveBeenCalledOnce();

    fallback.mockClear();
    const currentToken = await sign(CLAIMS);
    await validate({
      audience: "https://wrong.example",
      projectId: CLAIMS.projectId,
      token: currentToken,
    });
    expect(fallback).not.toHaveBeenCalled();
  });
});
