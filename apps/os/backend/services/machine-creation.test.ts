import { describe, test, expect, expectTypeOf } from "vitest";
import type { MachineState } from "../db/schema.ts";
import type { createMachineForProject } from "./machine-creation.ts";

describe("MachineState", () => {
  test("includes 'failed' state", () => {
    const states: readonly MachineState[] = [
      "starting",
      "active",
      "detached",
      "archived",
      "failed",
    ];
    expect(states).toContain("failed");
  });
});

describe("createMachineForProject return type", () => {
  test("does not include provisionPromise", () => {
    type Result = Awaited<ReturnType<typeof createMachineForProject>>;
    // provisionPromise should not be on the return type
    expectTypeOf<Result>().not.toHaveProperty("provisionPromise");
  });

  test("includes machine", () => {
    type Result = Awaited<ReturnType<typeof createMachineForProject>>;
    expectTypeOf<Result>().toHaveProperty("machine");
  });
});

describe("exports", () => {
  test("buildMachineEnvVars is exported", async () => {
    const mod = await import("./machine-creation.ts");
    expect(typeof mod.buildMachineEnvVars).toBe("function");
  });

  test("getOrCreateProjectMachineToken is exported", async () => {
    const mod = await import("./machine-creation.ts");
    expect(typeof mod.getOrCreateProjectMachineToken).toBe("function");
  });
});
