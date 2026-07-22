import { defineConfig } from "vitest/config";
import { RetryTelemetryReporter } from "@iterate-com/shared/test-support/e2e-policy";

// The live lane: drives the app's own client modules against a real
// deployment (see e2e/chat-roundtrip.e2e.test.ts for how to run it). Not part
// of root `pnpm test` — it needs a reachable server and Doppler credentials.
// Generous timeout: the assertion includes a real agent turn (LLM + possible
// code execution), which routinely takes tens of seconds.
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.test.ts"],
    environment: "node",
    testTimeout: 180_000,
    reporters: ["default", new RetryTelemetryReporter({ testKind: "e2e", lane: "vitest" })],
  },
});
