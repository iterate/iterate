import { describe, expect, test } from "vitest";
import { sameRepoBirthConfig, type RepoBirthConfig } from "./repo-processor-contract.ts";

const importedConfig = (owner: string, repo: string): RepoBirthConfig => ({
  github: {
    owner,
    repo,
    artifactImport: { branch: "main", commitOid: "imported-head", depth: 1 },
  },
});

describe("sameRepoBirthConfig", () => {
  test("treats GitHub owner and repository casing as the same durable source", () => {
    expect(
      sameRepoBirthConfig(
        importedConfig("Iterate", "Iterate"),
        importedConfig("iterate", "iterate"),
      ),
    ).toBe(true);
  });

  test("still distinguishes different GitHub repositories", () => {
    expect(
      sameRepoBirthConfig(
        importedConfig("iterate", "iterate"),
        importedConfig("iterate", "agents"),
      ),
    ).toBe(false);
  });

  test("allows a retry after the public repository head advances", () => {
    const retry = importedConfig("iterate", "iterate");
    retry.github!.artifactImport!.commitOid = "new-head";

    expect(sameRepoBirthConfig(importedConfig("iterate", "iterate"), retry)).toBe(true);
  });
});
