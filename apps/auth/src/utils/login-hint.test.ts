import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveLoginHintPresentation } from "./login-hint.ts";

const defaults = { emailOtpEnabled: true, fixedTestOtpEnabled: false, signedIn: false };

describe("deriveLoginHintPresentation", () => {
  it("an email-address hint offers Continue-as, without an OTP guess by default", () => {
    assert.deepEqual(deriveLoginHintPresentation({ ...defaults, loginHint: "misha@nustom.com" }), {
      hintedEmail: "misha@nustom.com",
      otpGuess: undefined,
      mode: undefined,
    });
  });

  it("a +test hint on a fixed-test-OTP deployment also guesses the code", () => {
    assert.deepEqual(
      deriveLoginHintPresentation({
        ...defaults,
        fixedTestOtpEnabled: true,
        loginHint: "pr2429+test@nustom.com",
      }),
      { hintedEmail: "pr2429+test@nustom.com", otpGuess: "424242", mode: undefined },
    );
  });

  it("a +test hint NEVER guesses the code when the fixed test OTP is off (prd)", () => {
    assert.deepEqual(
      deriveLoginHintPresentation({ ...defaults, loginHint: "pr2429+test@nustom.com" }),
      { hintedEmail: "pr2429+test@nustom.com", otpGuess: undefined, mode: undefined },
    );
  });

  it("a non-test address never guesses a code even with the fixed test OTP on", () => {
    assert.deepEqual(
      deriveLoginHintPresentation({
        ...defaults,
        fixedTestOtpEnabled: true,
        loginHint: "someone@example.com",
      }),
      { hintedEmail: "someone@example.com", otpGuess: undefined, mode: undefined },
    );
  });

  it("mode hints pass through; email mode needs the OTP feature", () => {
    assert.deepEqual(deriveLoginHintPresentation({ ...defaults, loginHint: "email" }), {
      hintedEmail: undefined,
      otpGuess: undefined,
      mode: "email",
    });
    assert.deepEqual(
      deriveLoginHintPresentation({ ...defaults, emailOtpEnabled: false, loginHint: "email" }),
      { hintedEmail: undefined, otpGuess: undefined, mode: undefined },
    );
    assert.deepEqual(deriveLoginHintPresentation({ ...defaults, loginHint: "google" }), {
      hintedEmail: undefined,
      otpGuess: undefined,
      mode: "google",
    });
  });

  it("email hints need the OTP feature too — no dead Continue-as button", () => {
    assert.deepEqual(
      deriveLoginHintPresentation({
        ...defaults,
        emailOtpEnabled: false,
        loginHint: "misha@nustom.com",
      }),
      { hintedEmail: undefined, otpGuess: undefined, mode: undefined },
    );
  });

  it("a signed-in account-chooser ignores every hint", () => {
    assert.deepEqual(
      deriveLoginHintPresentation({
        ...defaults,
        signedIn: true,
        fixedTestOtpEnabled: true,
        loginHint: "pr2429+test@nustom.com",
      }),
      { hintedEmail: undefined, otpGuess: undefined, mode: undefined },
    );
    assert.deepEqual(
      deriveLoginHintPresentation({ ...defaults, signedIn: true, loginHint: "google" }),
      {
        hintedEmail: undefined,
        otpGuess: undefined,
        mode: undefined,
      },
    );
  });

  it("no hint, nothing offered", () => {
    assert.deepEqual(deriveLoginHintPresentation({ ...defaults, loginHint: undefined }), {
      hintedEmail: undefined,
      otpGuess: undefined,
      mode: undefined,
    });
  });
});
