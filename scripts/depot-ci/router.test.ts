import { describe, expect, it } from "vitest";
import { depotRunHasFailed, parseDepotRunId } from "./router.ts";

describe("Depot CI router helpers", () => {
  it("parses run ids from depot ci run output", () => {
    expect(parseDepotRunId("Run: abc123\nView: https://depot.dev/...")).toBe("abc123");
  });

  it("treats failed nested workflow statuses as failed", () => {
    expect(
      depotRunHasFailed({
        status: "finished",
        workflows: [{ jobs: [{ attempts: [{ status: "failed" }], status: "finished" }] }],
      }),
    ).toBe(true);
  });

  it("does not mark successful finished statuses as failed", () => {
    expect(
      depotRunHasFailed({
        status: "finished",
        workflows: [{ jobs: [{ attempts: [{ status: "finished" }], status: "finished" }] }],
      }),
    ).toBe(false);
  });
});
