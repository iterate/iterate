import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getEmailOtpSenderAddress, sendEmailOtp, shouldUseTestOtp } from "./email.ts";

describe("email OTP", () => {
  it("recognizes the explicit +test tag in any domain case", () => {
    assert.equal(shouldUseTestOtp("alice+test@nustom.com"), true);
    assert.equal(shouldUseTestOtp("alice+work+TEST@NUSTOM.com"), true);
    assert.equal(shouldUseTestOtp("alice+contest@nustom.com"), false);
    assert.equal(shouldUseTestOtp("alice@nustom.com"), false);
  });

  it("builds the auth sender from the configured sender domain", () => {
    assert.equal(getEmailOtpSenderAddress(" nustom.com "), "noreply+auth@nustom.com");
  });

  it("sends OTP email through the Cloudflare binding when present", async () => {
    let sentMessage: unknown;

    await sendEmailOtp({
      email: "alice@nustom.com",
      otp: "123456",
      senderDomain: "nustom.com",
      emailBinding: {
        send: async (message) => {
          sentMessage = message;
        },
      },
    });

    assert.deepEqual(sentMessage, {
      from: { email: "noreply+auth@nustom.com", name: "Iterate" },
      to: "alice@nustom.com",
      subject: "Your verification code: 123456",
      text: "Your verification code is: 123456\n\nThis code expires in 5 minutes.",
    });
  });

  it("fails clearly when no email sender is configured", async () => {
    await assert.rejects(
      sendEmailOtp({
        email: "alice@nustom.com",
        otp: "123456",
        senderDomain: "nustom.com",
      }),
      /Cloudflare EMAIL send_email binding/,
    );
  });
});
