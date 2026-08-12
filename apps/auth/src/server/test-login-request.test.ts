import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTestLoginRequest } from "./test-login-request.ts";

// The allowlist a preview deployment would compute: its own origins plus the
// registered relying parties' redirect-URI origins.
const previewOrigins = [
  "https://auth.iterate-preview-3.com",
  "https://os.iterate-preview-3.com",
  "https://semaphore.iterate-preview-3.com",
];

// Real links are built with URLSearchParams (a literal + in a query string
// would decode to a space) — construct test URLs the same way.
function resolve(
  params: Record<string, string>,
  overrides?: { emailOtpEnabled?: boolean; fixedTestOtpEnabled?: boolean },
) {
  return resolveTestLoginRequest({
    url: new URL(`https://auth.iterate-preview-3.com/test-login?${new URLSearchParams(params)}`),
    emailOtpEnabled: overrides?.emailOtpEnabled ?? true,
    fixedTestOtpEnabled: overrides?.fixedTestOtpEnabled ?? true,
    allowedReturnToOrigins: previewOrigins,
  });
}

describe("resolveTestLoginRequest", () => {
  it("is a 404 wherever the fixed test OTP or email OTP is off (production)", () => {
    for (const overrides of [{ fixedTestOtpEnabled: false }, { emailOtpEnabled: false }]) {
      assert.deepEqual(resolve({ email: "pr123+test@nustom.com" }, overrides), {
        ok: false,
        status: 404,
        message: "Not found",
      });
    }
  });

  it("signs in the one-click preview shape: test email, project, os return_to", () => {
    assert.deepEqual(
      resolve({
        email: "pr123+test@nustom.com",
        project: "pr123",
        return_to: "https://os.iterate-preview-3.com/api/iterate-auth/login",
      }),
      {
        ok: true,
        email: "pr123+test@nustom.com",
        projectSlug: "pr123",
        returnTo: "https://os.iterate-preview-3.com/api/iterate-auth/login",
      },
    );
  });

  it("only accepts addresses the fixed OTP itself accepts", () => {
    for (const email of [
      "", // missing
      "someone@nustom.com", // no +test marker
      "alice+contest@nustom.com", // local part must END with +test
      "pr123+test@example.com", // wrong domain
    ]) {
      assert.deepEqual(resolve({ email }), {
        ok: false,
        status: 400,
        message: "email must be a *+test@nustom.com address (e.g. pr123+test@nustom.com)",
      });
    }
  });

  it("normalizes the email like the OTP flow does", () => {
    assert.partialDeepStrictEqual(resolve({ email: " PR123+test@NUSTOM.com" }), {
      ok: true,
      email: "pr123+test@nustom.com",
    });
  });

  it("derives the default project slug from the email local part", () => {
    assert.deepEqual(resolve({ email: "pr123+test@nustom.com" }), {
      ok: true,
      email: "pr123+test@nustom.com",
      projectSlug: "pr123",
      returnTo: "/",
    });
  });

  it("rejects malformed project slugs", () => {
    for (const project of ["Has-Caps", "under_score", "-leading", "a".repeat(51)]) {
      assert.deepEqual(resolve({ email: "pr123+test@nustom.com", project }), {
        ok: false,
        status: 400,
        message: "project must be a slug: lowercase letters, numbers, and dashes",
      });
    }
  });

  it("allows same-origin path return_to but not protocol-relative ones", () => {
    assert.partialDeepStrictEqual(
      resolve({ email: "pr123+test@nustom.com", return_to: "/after" }),
      { ok: true, returnTo: "/after" },
    );
    assert.partialDeepStrictEqual(
      resolve({ email: "pr123+test@nustom.com", return_to: "//evil.example/phish" }),
      { ok: false, status: 400 },
    );
  });

  it("rejects absolute return_to outside the registered relying parties", () => {
    for (const returnTo of [
      "https://evil.example/",
      "https://os.iterate-preview-4.com/api/iterate-auth/login", // another slot
      "javascript:alert(1)",
    ]) {
      assert.partialDeepStrictEqual(
        resolve({ email: "pr123+test@nustom.com", return_to: returnTo }),
        { ok: false, status: 400 },
      );
    }
  });
});
