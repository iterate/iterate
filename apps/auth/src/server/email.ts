export const TEST_OTP_CODE = "424242";

type EmailAddress = {
  email: string;
  name?: string;
};

export type CloudflareEmailBinding = {
  send(message: {
    to: string | EmailAddress | Array<string | EmailAddress>;
    from: string | EmailAddress;
    subject: string;
    text?: string;
    html?: string;
  }): Promise<unknown>;
};

export type SendEmailOtpOptions = {
  email: string;
  otp: string;
  senderDomain: string;
  emailBinding: CloudflareEmailBinding | undefined;
};

export type SendOrganizationInvitationEmailOptions = {
  email: string;
  role: string;
  organizationName: string;
  inviterName: string;
  inviterEmail: string;
  invitationUrl: string;
  senderDomain: string;
  emailBinding: CloudflareEmailBinding | undefined;
};

export function shouldUseTestOtp(input: { email: string; fixedTestOtpEnabled: boolean }) {
  if (!input.fixedTestOtpEnabled) {
    return false;
  }

  const email = input.email;
  const atIndex = email.indexOf("@");
  if (atIndex <= 0) {
    return false;
  }
  const localPart = email.slice(0, atIndex).toLowerCase();
  const domain = email.slice(atIndex + 1).toLowerCase();
  return localPart.endsWith("+test") && domain === "nustom.com";
}

export function getEmailOtpSenderAddress(senderDomain: string) {
  const domain = senderDomain.trim();
  if (!domain) {
    throw new Error("Email OTP sending requires APP_CONFIG_EMAIL_SENDER_DOMAIN");
  }
  return `noreply+auth@${domain}`;
}

export async function sendEmailOtp(options: SendEmailOtpOptions) {
  if (!options.emailBinding) {
    throw new Error("Email OTP sending requires the Cloudflare EMAIL send_email binding");
  }
  const fromEmail = getEmailOtpSenderAddress(options.senderDomain);
  await options.emailBinding.send({
    from: { email: fromEmail, name: "Iterate" },
    to: options.email,
    subject: `Your verification code: ${options.otp}`,
    text: `Your verification code is: ${options.otp}\n\nThis code expires in 5 minutes.`,
  });
}

export async function sendOrganizationInvitationEmail(
  options: SendOrganizationInvitationEmailOptions,
) {
  if (!options.emailBinding) {
    console.warn("Organization invitation email not sent: missing Cloudflare EMAIL binding");
    return;
  }
  if (!options.senderDomain.trim()) {
    console.warn("Organization invitation email not sent: missing APP_CONFIG_EMAIL_SENDER_DOMAIN");
    return;
  }

  const fromEmail = getEmailOtpSenderAddress(options.senderDomain);
  const inviterName = options.inviterName || options.inviterEmail;
  const roleLabel = options.role || "member";
  await options.emailBinding.send({
    from: { email: fromEmail, name: "Iterate" },
    to: options.email,
    subject: `${inviterName} invited you to ${options.organizationName} on Iterate`,
    text: [
      `${inviterName} (${options.inviterEmail}) invited you to join ${options.organizationName} on Iterate as ${roleLabel}.`,
      "",
      `Accept the invitation: ${options.invitationUrl}`,
      "",
      "You need to sign in with this email address before accepting.",
    ].join("\n"),
    html: [
      `<p>${escapeHtml(inviterName)} (${escapeHtml(options.inviterEmail)}) invited you to join <strong>${escapeHtml(options.organizationName)}</strong> on Iterate as ${escapeHtml(roleLabel)}.</p>`,
      `<p><a href="${escapeHtml(options.invitationUrl)}">Accept the invitation</a></p>`,
      "<p>You need to sign in with this email address before accepting.</p>",
    ].join(""),
  });
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
