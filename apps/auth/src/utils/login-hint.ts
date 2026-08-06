// The login page's reading of a `login_hint` search param — extracted pure so
// the behavior is pinned by unit tests independently of the React route
// (rewrite insurance: this + the authorize-redirect e2e in
// e2e/oauth-code-exchange.e2e.test.ts ARE the spec of the mobile preview
// deep-link sign-in flow).
//
// Three hint shapes:
// - "email" / "google": mode hints — deep-linkable shortcuts into this page's
//   email-code mode or the auto-started Google flow.
// - an email ADDRESS (standard OIDC login_hint, forwarded by the
//   oauth-provider's signed login redirect): offers a "Continue as <email>"
//   shortcut button and prefills the email form. For `*+test@nustom.com` on
//   deployments with the fixed test OTP, the code is knowable in advance and
//   rides along as `otpGuess` to prefill the OTP field. Never signs anyone in
//   by itself.
import { shouldUseTestOtp, TEST_OTP_CODE } from "../server/email.ts";

export function deriveLoginHintPresentation(input: {
  loginHint: string | undefined;
  emailOtpEnabled: boolean;
  fixedTestOtpEnabled: boolean;
  /** In the OAuth account-chooser state the hints are ignored entirely —
   * a signed-in user is choosing accounts, not typing credentials. */
  signedIn: boolean;
}): {
  hintedEmail: string | undefined;
  otpGuess: string | undefined;
  mode: "email" | "google" | undefined;
} {
  const { loginHint, emailOtpEnabled, fixedTestOtpEnabled, signedIn } = input;
  const hintedEmail =
    !signedIn && emailOtpEnabled && loginHint?.includes("@") ? loginHint : undefined;
  const otpGuess =
    hintedEmail !== undefined && shouldUseTestOtp({ email: hintedEmail, fixedTestOtpEnabled })
      ? TEST_OTP_CODE
      : undefined;
  const mode =
    !signedIn && loginHint === "email" && emailOtpEnabled
      ? loginHint
      : !signedIn && loginHint === "google"
        ? loginHint
        : undefined;
  return { hintedEmail, otpGuess, mode };
}
