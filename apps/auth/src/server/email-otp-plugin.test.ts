import assert from "node:assert/strict";
import { it } from "node:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createEmailOtpPlugin } from "./email-otp-plugin.ts";

it("admits 600 fixed-code OTP requests from one IP, then limits them, preserving production defaults", async () => {
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "fixed-otp-rate-limit-test-secret-value",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    rateLimit: { enabled: true },
    plugins: [
      createEmailOtpPlugin({
        fixedTestOtpEnabled: true,
        emailBinding: undefined,
        emailSenderDomain: "",
      }),
    ],
    telemetry: { enabled: false },
  });

  for (let index = 0; index <= 600; index++) {
    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/email-otp/send-verification-otp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "198.51.100.42",
        },
        body: JSON.stringify({
          email: `fixed-otp-rate-${index}+test@nustom.com`,
          type: "sign-in",
        }),
      }),
    );
    assert.equal(response.status, index < 600 ? 200 : 429, `OTP request ${index + 1}`);
  }

  const productionPlugin = createEmailOtpPlugin({
    fixedTestOtpEnabled: false,
    emailBinding: undefined,
    emailSenderDomain: "",
  });
  assert.equal(productionPlugin.options.rateLimit, undefined);
});
