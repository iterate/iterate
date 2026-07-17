import { expect, it } from "vitest";

import { config, createWranglerConfig } from "../scripts/generate-wrangler-config.ts";

it("omits the local seal-key var from deployment configs", () => {
  expect(config).toHaveProperty("vars.PETSHOP_SEAL_KEY");
  expect(createWranglerConfig({ forDeployment: true })).not.toHaveProperty("vars");
});
