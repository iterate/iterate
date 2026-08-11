import assert from "node:assert/strict";
import { it } from "node:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createEmailOtpPlugin } from "./email-otp-plugin.ts";

it("admits a full runner's fixed-code OTP signups without weakening the production limit", async () => {
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

  const responses: Response[] = [];
  for (const index of [0, 1, 2, 3]) {
    responses.push(
      await auth.handler(
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
      ),
    );
  }

  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200, 200, 200],
  );

  const productionPlugin = createEmailOtpPlugin({
    fixedTestOtpEnabled: false,
    emailBinding: undefined,
    emailSenderDomain: "",
  });
  assert.equal(productionPlugin.options.rateLimit, undefined);
});
