import { expect, it } from "vitest";

import { config, createWranglerConfig } from "../scripts/generate-wrangler-config.ts";

it("omits the local seal-key var from deployment configs", () => {
  expect(config).toHaveProperty("vars.PETSHOP_SEAL_KEY");
  expect(createWranglerConfig({ forDeployment: true })).not.toHaveProperty("vars");
});

it("binds immutable Worker version metadata in every environment", () => {
  expect(config).toHaveProperty("version_metadata.binding", "CF_VERSION_METADATA");
  for (const environment of Object.values(config.env)) {
    expect(environment).toHaveProperty("version_metadata.binding", "CF_VERSION_METADATA");
  }
});
