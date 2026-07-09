import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authEnvs } from "../../../envs.ts";
import { envShapedVars } from "./generate-wrangler-config.ts";

describe("auth wrangler config generation", () => {
  it("keeps the fixed test OTP disabled in production env-shaped vars", () => {
    assert.equal(authEnvs.prd.fixedTestOtpEnabled, false);
    assert.equal(envShapedVars(authEnvs.prd).APP_CONFIG_FIXED_TEST_OTP_ENABLED, "false");
  });

  it("keeps the fixed test OTP explicitly enabled in preview env-shaped vars", () => {
    assert.equal(authEnvs.preview_1.fixedTestOtpEnabled, true);
    assert.equal(envShapedVars(authEnvs.preview_1).APP_CONFIG_FIXED_TEST_OTP_ENABLED, "true");
  });
});
