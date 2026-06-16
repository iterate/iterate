import { describe, expect, it } from "vitest";
import { isMissingProjectWorkerProcessEventError } from "./project-worker-errors.ts";

describe("project worker runtime", () => {
  it("classifies absent optional processEvent hooks", () => {
    expect(
      isMissingProjectWorkerProcessEventError(
        new TypeError('The RPC receiver does not implement the method "processEvent".'),
      ),
    ).toBe(true);

    expect(
      isMissingProjectWorkerProcessEventError(
        new TypeError('The RPC receiver does not implement the method "fetch".'),
      ),
    ).toBe(false);
    expect(isMissingProjectWorkerProcessEventError(new Error("user hook failed"))).toBe(false);
  });
});
