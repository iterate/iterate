import { slugify } from "@iterate-com/shared/slug";
import { shouldUseTestOtp } from "./email.ts";

// Pure request validation for /test-login (see test-login.ts for the route):
// gating, param shapes, and the return_to allowlist — extracted so unit tests
// pin it (test-login-request.test.ts) without loading the worker module graph.

const PROJECT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type TestLoginResolution =
  | { ok: true; email: string; projectSlug: string; returnTo: string }
  | { ok: false; status: 400 | 404; message: string };

export function resolveTestLoginRequest(input: {
  url: URL;
  /** Both flags required: the endpoint drives the email-OTP plugin, which
   * only exists when emailOtpEnabled is on. */
  emailOtpEnabled: boolean;
  fixedTestOtpEnabled: boolean;
  /** Origins a return_to may point at: this deployment's own origins plus the
   * origins of registered relying parties (their OAuth redirect URIs). */
  allowedReturnToOrigins: string[];
}): TestLoginResolution {
  // 404, not 403: on deployments without the fixed test OTP (production) this
  // route does not exist, and we don't advertise otherwise.
  if (!input.fixedTestOtpEnabled || !input.emailOtpEnabled) {
    return { ok: false, status: 404, message: "Not found" };
  }

  const email = input.url.searchParams.get("email")?.trim().toLowerCase() || "";
  if (!shouldUseTestOtp({ email, fixedTestOtpEnabled: input.fixedTestOtpEnabled })) {
    return {
      ok: false,
      status: 400,
      message: "email must be a *+test@nustom.com address (e.g. pr123+test@nustom.com)",
    };
  }

  const rawProject = input.url.searchParams.get("project");
  if (rawProject !== null && (rawProject.length > 50 || !PROJECT_SLUG_PATTERN.test(rawProject))) {
    return {
      ok: false,
      status: 400,
      message: "project must be a slug: lowercase letters, numbers, and dashes",
    };
  }
  // Default slug from the email local part minus the +test marker:
  // pr123+test@nustom.com -> pr123.
  const projectSlug = rawProject || slugify(email.split("@")[0]!.replace(/\+test$/, ""));

  const rawReturnTo = input.url.searchParams.get("return_to");
  if (rawReturnTo === null || rawReturnTo === "") {
    return { ok: true, email, projectSlug, returnTo: "/" };
  }
  if (rawReturnTo.startsWith("/") && !rawReturnTo.startsWith("//")) {
    return { ok: true, email, projectSlug, returnTo: rawReturnTo };
  }
  if (URL.canParse(rawReturnTo)) {
    const returnToUrl = new URL(rawReturnTo);
    const isHttp = returnToUrl.protocol === "https:" || returnToUrl.protocol === "http:";
    if (isHttp && input.allowedReturnToOrigins.includes(returnToUrl.origin)) {
      return { ok: true, email, projectSlug, returnTo: returnToUrl.toString() };
    }
  }
  return {
    ok: false,
    status: 400,
    message: "return_to must be a same-origin path or a registered relying party URL",
  };
}
