/**
 * Ingress Fetcher Integration Test
 *
 * Verifies Sandbox.getFetcher() against a full sandbox entrypoint where pidnap
 * starts the machine ingress proxy on port 8080.
 */

import { describe } from "vitest";
import { RUN_SANDBOX_TESTS, TEST_CONFIG, test } from "./helpers.ts";

const TEST_TIMEOUT_MS = TEST_CONFIG.provider === "daytona" ? 180_000 : 120_000;
const HEALTH_POLL_TIMEOUT_MS = TEST_CONFIG.provider === "daytona" ? 90_000 : 30_000;
const PREVIEW_BODY = "ingress-preview-ok";
const PREVIEW_PORT = 3333;

describe.runIf(RUN_SANDBOX_TESTS)(`Ingress Fetcher (${TEST_CONFIG.provider})`, () => {
  test.scoped({
    sandboxOptions: {
      externalId: "test-ingress-fetcher",
      id: "ingress-fetcher",
      name: "Ingress Fetcher Test",
      envVars: {},
    },
  });

  test(
    "routes preview fetches through ingress proxy",
    async ({ sandbox, expect }) => {
      await expect
        .poll(
          async () =>
            (
              await sandbox.exec([
                "sh",
                "-c",
                "curl -sf --max-time 5 http://127.0.0.1:8080/health || true",
              ])
            )
              .trim()
              .toLowerCase(),
          { timeout: HEALTH_POLL_TIMEOUT_MS, interval: 500 },
        )
        .toContain("ok");

      await sandbox.exec(["sh", "-c", `echo "${PREVIEW_BODY}" > /tmp/ingress-preview.txt`]);
      await sandbox.exec([
        "sh",
        "-c",
        [
          "if command -v python3 >/dev/null 2>&1; then",
          `python3 -m http.server ${PREVIEW_PORT} --bind 0.0.0.0 --directory /tmp >/tmp/ingress-preview-server.log 2>&1 &`,
          "elif command -v python >/dev/null 2>&1; then",
          `python -m http.server ${PREVIEW_PORT} --bind 0.0.0.0 --directory /tmp >/tmp/ingress-preview-server.log 2>&1 &`,
          "elif command -v busybox >/dev/null 2>&1; then",
          `busybox httpd -p ${PREVIEW_PORT} -h /tmp >/tmp/ingress-preview-server.log 2>&1 &`,
          "else",
          "echo 'no-http-server' > /tmp/ingress-preview-server.log; exit 1;",
          "fi",
        ].join(" "),
      ]);

      const fetchPreview = await sandbox.getFetcher({ port: PREVIEW_PORT });

      await expect
        .poll(
          async () => {
            const response = await fetchPreview("/ingress-preview.txt").catch(() => null);
            if (!response?.ok) return "";
            return await response.text();
          },
          { timeout: 20_000, interval: 500 },
        )
        .toContain(PREVIEW_BODY);
    },
    TEST_TIMEOUT_MS,
  );
});
