import { fileURLToPath } from "node:url";

/** Every workspace's vitest reporters: the console's, and the retry telemetry CI uploads
 *  (docs/ci-test-telemetry.md). Each vitest.config.ts sets `test.reporters` to this, so every
 *  `test` script is plain `vitest run`. */
export const vitestReporters = [
  "default",
  fileURLToPath(new URL("./retry-telemetry-reporter.ts", import.meta.url)),
];
