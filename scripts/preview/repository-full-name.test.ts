import { describe, expect, it } from "vitest";
import { splitRepositoryFullName } from "./repository-full-name.ts";

describe("splitRepositoryFullName", () => {
  it("parses owner/repo", () => {
    expect(splitRepositoryFullName("iterate/iterate")).toEqual(["iterate", "iterate"]);
  });

  it("rejects malformed repository names", () => {
    expect(() => splitRepositoryFullName("iterate")).toThrow(
      "Expected repository full name to look like owner/repo.",
    );
    expect(() => splitRepositoryFullName("iterate/iterate/extra")).toThrow(
      "Expected repository full name to look like owner/repo.",
    );
  });
});
