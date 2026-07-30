import { describe, expect, test } from "vitest";
import {
  deploymentStatusFromState,
  deploymentStatusesFromProbes,
} from "./project-deployment-status.ts";

describe("deploymentStatusFromState", () => {
  const request = { config: { slug: "project" } };
  test.each([
    {
      expected: "created",
      state: {
        birthCertificate: { ...request, createRequestedAtOffset: 1 },
        createFailure: null,
        createRequest: request,
      },
    },
    {
      expected: "failed",
      state: {
        birthCertificate: null,
        createFailure: { createRequestedAtOffset: 1, error: "failed", request },
        createRequest: request,
      },
    },
    {
      expected: "creating",
      state: { birthCertificate: null, createFailure: null, createRequest: request },
    },
    {
      expected: "missing",
      state: { birthCertificate: null, createFailure: null, createRequest: null },
    },
  ] as const)("projects canonical $expected status", ({ expected, state }) => {
    expect(deploymentStatusFromState(state)).toBe(expected);
  });
});

function fulfilled(
  value: "created" | "creating" | "failed" | "missing",
): PromiseSettledResult<"created" | "creating" | "failed" | "missing"> {
  return { status: "fulfilled", value };
}

describe("deploymentStatusesFromProbes", () => {
  test("preserves every known engine lifecycle status", () => {
    const statuses = deploymentStatusesFromProbes(
      ["prj_a", "prj_b", "prj_c", "prj_d"],
      [fulfilled("created"), fulfilled("creating"), fulfilled("failed"), fulfilled("missing")],
    );
    expect(statuses.get("prj_a")).toBe("created");
    expect(statuses.get("prj_b")).toBe("creating");
    expect(statuses.get("prj_c")).toBe("failed");
    expect(statuses.get("prj_d")).toBe("missing");
  });

  test("a rejected probe degrades that project to unknown, not the whole list", () => {
    const statuses = deploymentStatusesFromProbes(
      ["prj_a", "prj_b", "prj_c"],
      [
        fulfilled("created"),
        { status: "rejected", reason: new Error("engine hiccup") },
        fulfilled("missing"),
      ],
    );
    expect(statuses.get("prj_a")).toBe("created");
    expect(statuses.get("prj_b")).toBe("unknown");
    expect(statuses.get("prj_c")).toBe("missing");
  });

  test("a missing outcome (shorter results array) is unknown", () => {
    const statuses = deploymentStatusesFromProbes(["prj_a", "prj_b"], [fulfilled("created")]);
    expect(statuses.get("prj_b")).toBe("unknown");
  });

  test("empty input produces an empty map", () => {
    expect(deploymentStatusesFromProbes([], []).size).toBe(0);
  });
});
