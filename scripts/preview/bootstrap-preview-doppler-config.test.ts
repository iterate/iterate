import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rewritePreviewSecretValues } from "./bootstrap-preview-doppler-config.ts";

describe("rewritePreviewSecretValues", () => {
  it("rewrites numbered preview hostnames and worker script names", () => {
    assert.deepEqual(
      rewritePreviewSecretValues({
        secrets: {
          APP_CONFIG_BASE_URL: "https://os.iterate-preview-2.com",
          DEPLOYMENT_BASE_URL: "iterate-preview-2.com",
          DEPLOYMENT_CONFIG_STREAM_DURABLE_OBJECT_BINDING_SCRIPT_NAME: "os-preview-2",
          DOPPLER_CONFIG: "preview_2",
        },
        sourcePreviewNumber: 2,
        targetPreviewNumber: 1,
      }),
      {
        APP_CONFIG_BASE_URL: "https://os.iterate-preview-1.com",
        DEPLOYMENT_BASE_URL: "iterate-preview-1.com",
        DEPLOYMENT_CONFIG_STREAM_DURABLE_OBJECT_BINDING_SCRIPT_NAME: "os-preview-1",
      },
    );
  });
});
