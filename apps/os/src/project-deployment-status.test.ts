import { describe, expect, test } from "vitest";
import { deploymentStatusesFromProbes } from "./project-deployment-status.ts";

function fulfilled(value: boolean): PromiseSettledResult<boolean> {
  return { status: "fulfilled", value };
}

describe("deploymentStatusesFromProbes", () => {
  test("created=true is ready, created=false is missing", () => {
    const statuses = deploymentStatusesFromProbes(
      ["prj_a", "prj_b"],
      [fulfilled(true), fulfilled(false)],
    );
    expect(statuses.get("prj_a")).toBe("ready");
    expect(statuses.get("prj_b")).toBe("missing");
  });

  test("a rejected probe degrades that project to unknown, not the whole list", () => {
    const statuses = deploymentStatusesFromProbes(
      ["prj_a", "prj_b", "prj_c"],
      [
        fulfilled(true),
        { status: "rejected", reason: new Error("engine hiccup") },
        fulfilled(false),
      ],
    );
    expect(statuses.get("prj_a")).toBe("ready");
    expect(statuses.get("prj_b")).toBe("unknown");
    expect(statuses.get("prj_c")).toBe("missing");
  });

  test("a missing outcome (shorter results array) is unknown", () => {
    const statuses = deploymentStatusesFromProbes(["prj_a", "prj_b"], [fulfilled(true)]);
    expect(statuses.get("prj_b")).toBe("unknown");
  });

  test("empty input produces an empty map", () => {
    expect(deploymentStatusesFromProbes([], []).size).toBe(0);
  });
});
