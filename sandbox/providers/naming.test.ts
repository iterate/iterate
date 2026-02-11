import { describe, expect, it } from "vitest";
import {
  MAX_CANONICAL_MACHINE_NAME_LENGTH,
  buildCanonicalMachineExternalId,
  shortenKeepingEnds,
} from "./naming.ts";

describe("shortenKeepingEnds", () => {
  it("returns original when already within limit", () => {
    expect(
      shortenKeepingEnds({ value: "dev-project-mach-123456", maxLength: 63, preserveEnd: 6 }),
    ).toBe("dev-project-mach-123456");
  });

  it("preserves trailing characters when truncating", () => {
    const shortened = shortenKeepingEnds({
      value: "project-with-a-very-long-slug-mach-01k8j0abcdxyz1234567890pqrs",
      maxLength: 25,
      preserveEnd: 6,
    });
    expect(shortened.endsWith("90pqrs")).toBe(true);
    expect(shortened.length).toBeLessThanOrEqual(25);
  });
});

describe("buildCanonicalMachineExternalId", () => {
  it("builds deterministic canonical IDs", () => {
    const externalId = buildCanonicalMachineExternalId({
      prefix: "dev",
      projectSlug: "my-project",
      machineId: "mach_01k8j0abcdxyz1234567890pqrs",
    });
    expect(externalId).toBe("dev-my-project-mach-01k8j0abcdxyz1234567890pqrs");
  });

  it("respects max length by truncating only project slug", () => {
    const machineId = "mach_01k8j0abcdxyz1234567890pqrs";
    const externalId = buildCanonicalMachineExternalId({
      prefix: "stg",
      projectSlug: "project-with-a-really-really-really-really-really-long-slug",
      machineId,
    });

    expect(externalId.length).toBeLessThanOrEqual(MAX_CANONICAL_MACHINE_NAME_LENGTH);
    expect(externalId.startsWith("stg-")).toBe(true);
    expect(externalId.endsWith(`-${machineId.replaceAll("_", "-")}`)).toBe(true);
  });

  it("throws when full machine id cannot fit with prefix", () => {
    expect(() =>
      buildCanonicalMachineExternalId({
        prefix: "dev",
        projectSlug: "project",
        machineId: `mach_${"a".repeat(80)}`,
      }),
    ).toThrow(/too long/i);
  });
});
