import { defineConfig, mergeConfig } from "vitest/config";
import shared from "./vitest.config.ts";

if (!process.env.WORKER_BASE_URL)
  throw new Error("Use pnpm e2e:celld to boot the local celld target");

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      name: "celld",
      maxWorkers: 4,
      retry: 0,
      exclude: [
        // These tests start their own Wrangler process, independently of WORKER_BASE_URL.
        "e2e/auth.e2e.test.ts",
        "e2e/push-delivery-no-dropped-warns.e2e.test.ts",
        // Provider credentials, real external services or public ingress are not local acceptance.
        "e2e/*deployed*",
        "e2e/*tunnel*",
        "e2e/*ai-root*",
        "e2e/*library-connectors*",
        "e2e/workers-remote-capnweb.e2e.test.ts",
        // Deliberate pressure/recovery workloads require a separately provisioned resource budget.
        "e2e/*memory-budget*",
        "e2e/*lifecycle-recovery*",
        "e2e/*uncontrolled-degradation*",
        "e2e/*throughput*",
      ],
    },
  }),
);
