import { localTest as test, describe, expect } from "../fixtures.ts";

describe("Pidnap Process Supervisor", () => {
  test("services.waitHealthy returns success with logs", async ({ sandbox }) => {
    const result = await sandbox.waitForServiceHealthy("iterate-daemon", 5000);
    expect(result.healthy).toBe(true);
    expect(result.state).toBe("running");
    expect(result.logs.length).toBeGreaterThan(0);
  });

  test("services.waitHealthy timeout for non-existent service", async ({ sandbox }) => {
    const output = await sandbox.exec([
      "sh",
      "-c",
      'curl -s http://localhost:9876/rpc/services/waitHealthy -H "Content-Type: application/json" -d \'{"json":{"service":"nonexistent","timeoutMs":1000}}\' || echo "CURL_FAILED"',
    ]);
    expect(output.toLowerCase()).toMatch(/not.?found|error|curl_failed/i);
  });
});
