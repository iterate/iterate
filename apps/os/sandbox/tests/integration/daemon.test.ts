import { integrationTest as test, describe, expect } from "../fixtures.ts";
import type { MockIterateOsApi, OrpcProcedure } from "../mock-iterate-os-api/types.ts";

const hasProvider =
  process.env.RUN_LOCAL_DOCKER_TESTS === "true" || process.env.RUN_DAYTONA_TESTS === "true";
const describeIfProvider = describe.runIf(hasProvider);

function buildEnvVars(vars: Record<string, string>) {
  return Object.entries(vars).map(([key, value]) => ({
    key,
    value,
    secret: null,
    description: null,
    source: { type: "user" as const, envVarId: `mock-${key.toLowerCase()}` },
  }));
}

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

describeIfProvider("Daemon Control Plane Integration", () => {
  test("calls getEnv on startup and applies env vars", async ({ sandbox, mock }) => {
    await waitForOrpc(mock, "machines.reportStatus");
    await waitForOrpc(mock, "machines.getEnv");

    mock.orpc.setGetEnvResponse({
      envVars: buildEnvVars({ TEST_VAR: "test-value", SECRET_KEY: "secret-123" }),
      repos: [],
    });
    mock.resetRequests();
    await sandbox.restart();
    await sandbox.waitForServiceHealthy("daemon-backend");
    await waitForOrpc(mock, "machines.reportStatus");
    await waitForOrpc(mock, "machines.getEnv");

    const envFile = await sandbox.exec(["cat", "/home/iterate/.iterate/.env"]);
    expect(envFile).toContain('TEST_VAR="test-value"');
  });

  test("daemon survives restart and reconnects", async ({ sandbox, mock }) => {
    mock.resetRequests();

    await sandbox.restart();
    await sandbox.waitForServiceHealthy("daemon-backend");

    await waitForOrpc(mock, "machines.reportStatus");
    await waitForOrpc(mock, "machines.getEnv");
  });
});
