import { describe, expect, it } from "vitest";
import { slugify } from "../utils.ts";
import { buildDaytonaSandboxName } from "./provider.ts";

describe("buildDaytonaSandboxName", () => {
  it("includes the full machine id when prefixes are long", () => {
    const machineId = "mach_01K8J0ABCDXYZ1234567890PQRS";
    const machineSlug = slugify(machineId);

    const name = buildDaytonaSandboxName({
      config: "development-super-long-config-name",
      project: "project-with-a-really-long-slug",
      machine: machineId,
      suffix: "abc123",
    });

    expect(name.endsWith(`${machineSlug}-abc123`)).toBe(true);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it("drops prefixes before truncating machine id", () => {
    const machineId = `mach_${"a".repeat(51)}`;
    const machineSlug = slugify(machineId);

    const name = buildDaytonaSandboxName({
      config: "development",
      project: "project",
      machine: machineId,
      suffix: "abc123",
    });

    expect(name).toBe(`${machineSlug}-abc123`);
    expect(name.length).toBe(63);
  });

  it("falls back to machine id when machine+suffix exceeds max length", () => {
    const machineId = `mach_${"a".repeat(90)}`;
    const machineSlug = slugify(machineId);

    const name = buildDaytonaSandboxName({
      config: "development",
      project: "project",
      machine: machineId,
      suffix: "abc123",
    });

    expect(name).toBe(machineSlug);
    expect(name.length).toBe(63);
  });
});
