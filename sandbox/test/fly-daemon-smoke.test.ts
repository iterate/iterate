import { describe } from "vitest";
import { RUN_SANDBOX_TESTS, TEST_CONFIG, test } from "./helpers.ts";

const TEST_RUN_SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_EXTERNAL_ID = `test-fly-daemon-smoke-${TEST_RUN_SUFFIX}`;
const TEST_ID = `fly-daemon-smoke-${TEST_RUN_SUFFIX}`;
const FLY_DAEMON_SMOKE_TIMEOUT_MS = 420_000;

describe.runIf(RUN_SANDBOX_TESTS && TEST_CONFIG.provider === "fly")("Fly Daemon Smoke", () => {
  test.scoped({
    sandboxOptions: {
      externalId: TEST_EXTERNAL_ID,
      id: TEST_ID,
      name: "Fly Daemon Smoke",
      envVars: {},
    },
  });

  test(
    "default sandbox entrypoint boots pidnap and daemon services",
    async ({ sandbox, expect }) => {
      await expect
        .poll(
          async () => {
            try {
              return await sandbox.exec([
                "sh",
                "-c",
                "curl -sSf --max-time 5 http://127.0.0.1:3001/api/health",
              ]);
            } catch {
              return "";
            }
          },
          { timeout: 180_000, interval: 1_000 },
        )
        .toContain('"status":"ok"');

      await expect
        .poll(
          async () => {
            try {
              return await sandbox.exec([
                "sh",
                "-c",
                "curl -I -sSf --max-time 5 http://127.0.0.1:3000 | head -n 1",
              ]);
            } catch {
              return "";
            }
          },
          { timeout: 180_000, interval: 1_000 },
        )
        .toContain("200");

      const pidnapRunning = await sandbox.exec([
        "sh",
        "-c",
        "ps -ef | grep -v grep | grep -q 'pidnap/src/cli.ts' && echo yes || echo no",
      ]);
      expect(pidnapRunning.trim()).toBe("yes");
    },
    FLY_DAEMON_SMOKE_TIMEOUT_MS,
  );
});
