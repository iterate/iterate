import { integrationTest as test, describe, expect } from "../fixtures.ts";
import type { MockIterateOsApi, OrpcProcedure } from "../mock-iterate-os-api/types.ts";

async function waitForOrpc(
  mock: MockIterateOsApi,
  procedure: OrpcProcedure,
  minCount = 1,
  timeoutMs = 30_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (mock.orpc.getRequests(procedure).length >= minCount) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timeout waiting for ${procedure} to be called`);
}

describe("Daemon Control Plane Integration", () => {
  test("calls getEnv on startup and applies env vars", async ({ sandbox, mock }) => {
    await waitForOrpc(mock, "machines.reportStatus");
    await waitForOrpc(mock, "machines.getEnv");

    mock.orpc.setGetEnvResponse({
      envVars: { TEST_VAR: "test-value", SECRET_KEY: "secret-123" },
      repos: [],
    });
    mock.resetRequests();
    await sandbox.restart();
    await sandbox.waitForServiceHealthy("iterate-daemon");
    await waitForOrpc(mock, "machines.reportStatus");
    await waitForOrpc(mock, "machines.getEnv");

    const envFile = await sandbox.exec(["cat", "/home/iterate/.iterate/.env"]);
    expect(envFile).toContain('TEST_VAR="test-value"');
  });

  test("daemon survives restart and reconnects", async ({ sandbox, mock }) => {
    mock.resetRequests();

    await sandbox.restart();
    await sandbox.waitForServiceHealthy("iterate-daemon");

    await waitForOrpc(mock, "machines.reportStatus");
    await waitForOrpc(mock, "machines.getEnv");
  });
});
