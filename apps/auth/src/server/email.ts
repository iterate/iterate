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

export function shouldUseTestOtp(email: string) {
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
