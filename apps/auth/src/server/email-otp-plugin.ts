import { emailOTP } from "better-auth/plugins";
import {
  type CloudflareEmailBinding,
  TEST_OTP_CODE,
  sendEmailOtp,
  shouldUseTestOtp,
} from "./email.ts";

export type EmailOtpPluginOptions = {
  fixedTestOtpEnabled: boolean;
  emailBinding: CloudflareEmailBinding | undefined;
  emailSenderDomain: string;
};

export function createEmailOtpPlugin(options: EmailOtpPluginOptions) {
  return emailOTP({
    otpLength: 6,
    expiresIn: 300,
    // Browser e2e shares one runner IP and deliberately signs up several
    // unique fixed-code users at once. Keep that non-production lane bounded
    // without applying Better Auth's human-facing three-per-minute ceiling.
    ...(options.fixedTestOtpEnabled && { rateLimit: { window: 60, max: 100 } }),
    generateOTP: ({ email }) => {
      if (shouldUseTestOtp({ email, fixedTestOtpEnabled: options.fixedTestOtpEnabled })) {
        return TEST_OTP_CODE;
      }
      return undefined;
    },
    sendVerificationOTP: async ({ email, otp }) => {
      if (shouldUseTestOtp({ email, fixedTestOtpEnabled: options.fixedTestOtpEnabled })) {
        return;
      }

      await sendEmailOtp({
        email,
        otp,
        senderDomain: options.emailSenderDomain,
        emailBinding: options.emailBinding,
      });
    },
  });
}
