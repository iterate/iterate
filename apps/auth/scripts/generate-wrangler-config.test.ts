import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authEnvs } from "../../../envs.ts";
import { config, DERIVED_SECRETS, envShapedVars } from "./generate-wrangler-config.ts";

describe("auth wrangler config generation", () => {
  it("keeps the fixed test OTP disabled in production env-shaped vars", () => {
    assert.equal(authEnvs.prd.fixedTestOtpEnabled, false);
    assert.equal(envShapedVars(authEnvs.prd).APP_CONFIG_FIXED_TEST_OTP_ENABLED, "false");
  });

  it("keeps the fixed test OTP explicitly enabled in preview env-shaped vars", () => {
    assert.equal(authEnvs.preview_1.fixedTestOtpEnabled, true);
    assert.equal(envShapedVars(authEnvs.preview_1).APP_CONFIG_FIXED_TEST_OTP_ENABLED, "true");
  });

  it("does not ask deployed builds for secrets that deploy.ts derives later", () => {
    for (const [envName, env] of Object.entries(config.env)) {
      for (const secretName of DERIVED_SECRETS) {
        assert.equal(env.secrets.required.includes(secretName), false, `${envName}: ${secretName}`);
      }
    }
  });

  it("binds immutable Worker version metadata in local and deployed environments", () => {
    assert.deepEqual(config.version_metadata, { binding: "CF_VERSION_METADATA" });
    for (const [envName, env] of Object.entries(config.env)) {
      assert.deepEqual(
        env.version_metadata,
        { binding: "CF_VERSION_METADATA" },
        `${envName}: version metadata`,
      );
    }
  });
});
