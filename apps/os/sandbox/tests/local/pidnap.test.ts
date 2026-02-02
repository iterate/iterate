import { localTest as test, describe, expect } from "../fixtures.ts";

const hasProvider =
  process.env.RUN_LOCAL_DOCKER_TESTS === "true" || process.env.RUN_DAYTONA_TESTS === "true";
const describeIfProvider = describe.runIf(hasProvider);

describeIfProvider("Pidnap Process Supervisor", () => {
  test("processes.get returns running state", async ({ sandbox }) => {
    const result = await sandbox.waitForServiceHealthy("iterate-daemon", 5000);
    expect(result.healthy).toBe(true);
    expect(result.state).toBe("running");
  });

  test("processes.get fails for non-existent service", async ({ sandbox }) => {
    const output = await sandbox.exec([
      "sh",
      "-c",
      'curl -s http://localhost:9876/rpc/processes/get -H "Content-Type: application/json" -d \'{"json":{"target":"nonexistent"}}\' || echo "CURL_FAILED"',
    ]);
    expect(output.toLowerCase()).toMatch(/process not found|not.?found|error|curl_failed/i);
  });
});
