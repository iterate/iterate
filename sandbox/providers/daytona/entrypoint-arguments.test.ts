import { describe } from "vitest";
import { RUN_SANDBOX_TESTS, TEST_CONFIG, test } from "../../test/helpers.ts";

describe
  .runIf(RUN_SANDBOX_TESTS && TEST_CONFIG.provider === "daytona")
  .concurrent("Daytona Entrypoint Arguments", () => {
    test.scoped({
      sandboxOptions: {
        id: "daytona-entrypoint-arguments",
        name: "Daytona Entrypoint Arguments",
        envVars: {},
        entrypointArguments: ["sleep", "infinity"],
      },
    });

    test("maps entrypoint args to SANDBOX_ENTRY_ARGS and bypasses pidnap", async ({
      sandbox,
      expect,
    }) => {
      const reachedEntrypoint = await sandbox.exec([
        "sh",
        "-c",
        "test -f /tmp/reached-entrypoint && echo yes || echo no",
      ]);
      expect(reachedEntrypoint.trim()).toBe("yes");

      const entryArgsFromEnv = await sandbox.exec([
        "sh",
        "-c",
        "printf '%s' \"${SANDBOX_ENTRY_ARGS:-}\"",
      ]);
      expect(entryArgsFromEnv).toBe("sleep\tinfinity");

      const pidnapRunning = await sandbox.exec([
        "sh",
        "-c",
        "ps -ef | grep -v grep | grep -q 'pidnap/src/cli.ts' && echo yes || echo no",
      ]);
      expect(pidnapRunning.trim()).toBe("no");
    }, 180_000);
  });
