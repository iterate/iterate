import { describe, expect, test } from "vitest";
import { isItxAccessError } from "./errors.ts";

describe("isItxAccessError", () => {
  test("matches the kernel's authorization/existence failures", () => {
    expect(isItxAccessError(new Error("Project prj_d871 not found."))).toBe(true);
    expect(isItxAccessError(new Error("Context not found"))).toBe(true);
    expect(isItxAccessError(new Error("Project iterate is not accessible."))).toBe(true);
    expect(
      isItxAccessError(new Error("Global streams need admin access. Narrow to a project first.")),
    ).toBe(true);
    expect(isItxAccessError(new Error("FORBIDDEN"))).toBe(true);
    expect(isItxAccessError("Unauthorized")).toBe(true);
  });

  test("does not match transient failures", () => {
    expect(isItxAccessError(new Error("subscribe exploded"))).toBe(false);
    expect(isItxAccessError(new Error("The itx connection was closed."))).toBe(false);
    expect(isItxAccessError(new Error("network timeout"))).toBe(false);
    expect(isItxAccessError(new Error("WebSocket peer disconnected"))).toBe(false);
  });
});
