import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authEnvs } from "../../../envs.ts";
import { DERIVED_SECRETS, envShapedVars, wranglerConfig } from "./generate-wrangler-config.ts";

const deployedConfig = wranglerConfig("preview_1", {
  kind: "auth",
  authDbId: "test-auth-db",
});

describe("auth wrangler config generation", () => {
  it("binds deployed D1 by Alchemy's database id without reconstructing its name", () => {
    assert.equal(deployedConfig.env.preview_1.d1_databases[0]?.database_id, "test-auth-db");
    assert.equal("database_name" in deployedConfig.env.preview_1.d1_databases[0]!, false);
  });

  it("keeps the fixed test OTP disabled in production env-shaped vars", () => {
    assert.equal(authEnvs.prd.fixedTestOtpEnabled, false);
    assert.equal(envShapedVars(authEnvs.prd).APP_CONFIG_FIXED_TEST_OTP_ENABLED, "false");
  });

  it("keeps the fixed test OTP explicitly enabled in preview env-shaped vars", () => {
    assert.equal(authEnvs.preview_1.fixedTestOtpEnabled, true);
    assert.equal(envShapedVars(authEnvs.preview_1).APP_CONFIG_FIXED_TEST_OTP_ENABLED, "true");
  });

  it("does not ask deployed builds for secrets that deploy.ts derives later", () => {
    for (const [envName, env] of Object.entries(deployedConfig.env)) {
      for (const secretName of DERIVED_SECRETS) {
        assert.equal(env.secrets.required.includes(secretName), false, `${envName}: ${secretName}`);
      }
    }
  });
});
