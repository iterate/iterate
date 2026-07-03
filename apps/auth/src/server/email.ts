const TEST_EMAIL_PATTERN = /\+.*test@/i;

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
  emailBinding?: CloudflareEmailBinding | null;
  resendApiKey?: string;
};

export function shouldUseTestOtp(email: string) {
  return TEST_EMAIL_PATTERN.test(email);
}

export function getEmailOtpSenderAddress(senderDomain: string) {
  const domain = senderDomain.trim();
  if (!domain) {
    throw new Error(
      "Email OTP sending requires APP_CONFIG_EMAIL_SENDER_DOMAIN or legacy APP_CONFIG_RESEND_DOMAIN",
    );
  }
  return `noreply+auth@${domain}`;
}

export async function sendEmailOtp(options: SendEmailOtpOptions) {
  const fromEmail = getEmailOtpSenderAddress(options.senderDomain);
  const subject = `Your verification code: ${options.otp}`;
  const text = `Your verification code is: ${options.otp}\n\nThis code expires in 5 minutes.`;

  if (options.emailBinding) {
    await options.emailBinding.send({
      from: { email: fromEmail, name: "Iterate" },
      to: options.email,
      subject,
      text,
    });
    return;
  }

  const resendApiKey = options.resendApiKey?.trim();
  if (!resendApiKey) {
    throw new Error(
      "Email OTP sending requires the Cloudflare EMAIL send_email binding or legacy APP_CONFIG_RESEND_API_KEY",
    );
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${resendApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: `Iterate <${fromEmail}>`,
      to: options.email,
      subject,
      text,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to send verification email: ${response.status}`);
  }
}
