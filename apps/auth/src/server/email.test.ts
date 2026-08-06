import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getEmailOtpRateLimit,
  getEmailOtpSenderAddress,
  sendEmailOtp,
  sendOrganizationInvitationEmail,
  shouldUseTestOtp,
} from "./email.ts";

describe("email OTP", () => {
  it("recognizes the explicit +test tag only on nustom.com", () => {
    assert.equal(
      shouldUseTestOtp({ email: "alice+test@nustom.com", fixedTestOtpEnabled: true }),
      true,
    );
    assert.equal(
      shouldUseTestOtp({ email: "alice+work+TEST@NUSTOM.com", fixedTestOtpEnabled: true }),
      true,
    );
    assert.equal(
      shouldUseTestOtp({ email: "alice+contest@nustom.com", fixedTestOtpEnabled: true }),
      false,
    );
    assert.equal(
      shouldUseTestOtp({ email: "alice+test@example.com", fixedTestOtpEnabled: true }),
      false,
    );
    assert.equal(shouldUseTestOtp({ email: "alice@nustom.com", fixedTestOtpEnabled: true }), false);
  });

  it("does not use the fixed test OTP when config disables it", () => {
    assert.equal(
      shouldUseTestOtp({ email: "alice+test@nustom.com", fixedTestOtpEnabled: false }),
      false,
    );
  });

  it("allows the fully parallel preview signup lane only on fixed-test-OTP stages", () => {
    assert.deepEqual(getEmailOtpRateLimit(true), { max: 100, window: 60 });
    assert.deepEqual(getEmailOtpRateLimit(false), { max: 3, window: 60 });
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
      from: { email: "noreply+auth@nustom.com", name: "iterate" },
      to: "alice@nustom.com",
      subject: "Your verification code: 123456",
      text: "Your verification code is: 123456\n\nThis code expires in 5 minutes.",
    });
  });

  it("fails clearly when the EMAIL binding is missing", async () => {
    await assert.rejects(
      sendEmailOtp({
        email: "alice@nustom.com",
        otp: "123456",
        senderDomain: "nustom.com",
        emailBinding: undefined,
      }),
      /Cloudflare EMAIL send_email binding/,
    );
  });
});

describe("organization invitation email", () => {
  it("sends an invitation link through the Cloudflare binding when present", async () => {
    let sentMessage: unknown;

    await sendOrganizationInvitationEmail({
      email: "alice@nustom.com",
      role: "admin",
      organizationName: "Nustom",
      inviterName: "Sam Inviter",
      inviterEmail: "sam@nustom.com",
      invitationUrl: "https://auth.iterate.com/invitations/inv_123",
      senderDomain: "nustom.com",
      emailBinding: {
        send: async (message) => {
          sentMessage = message;
        },
      },
    });

    assert.deepEqual(sentMessage, {
      from: { email: "noreply+auth@nustom.com", name: "iterate" },
      to: "alice@nustom.com",
      subject: "Sam Inviter invited you to Nustom on iterate",
      text: [
        "Sam Inviter (sam@nustom.com) invited you to join Nustom on iterate as admin.",
        "",
        "Accept the invitation: https://auth.iterate.com/invitations/inv_123",
        "",
        "You need to sign in with this email address before accepting.",
      ].join("\n"),
      html: [
        "<p>Sam Inviter (sam@nustom.com) invited you to join <strong>Nustom</strong> on iterate as admin.</p>",
        '<p><a href="https://auth.iterate.com/invitations/inv_123">Accept the invitation</a></p>',
        "<p>You need to sign in with this email address before accepting.</p>",
      ].join(""),
    });
  });

  it("fails clearly when the EMAIL binding is missing", async () => {
    await assert.rejects(
      sendOrganizationInvitationEmail({
        email: "alice@nustom.com",
        role: "member",
        organizationName: "Nustom",
        inviterName: "Sam Inviter",
        inviterEmail: "sam@nustom.com",
        invitationUrl: "https://auth.iterate.com/invitations/inv_123",
        senderDomain: "nustom.com",
        emailBinding: undefined,
      }),
      /Organization invitation email sending requires the Cloudflare EMAIL send_email binding/,
    );
  });

  it("fails clearly when the sender domain is missing", async () => {
    await assert.rejects(
      sendOrganizationInvitationEmail({
        email: "alice@nustom.com",
        role: "member",
        organizationName: "Nustom",
        inviterName: "Sam Inviter",
        inviterEmail: "sam@nustom.com",
        invitationUrl: "https://auth.iterate.com/invitations/inv_123",
        senderDomain: " ",
        emailBinding: {
          send: async () => undefined,
        },
      }),
      /Organization invitation email sending requires APP_CONFIG_EMAIL_SENDER_DOMAIN/,
    );
  });
});
