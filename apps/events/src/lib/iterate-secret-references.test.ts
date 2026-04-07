import { describe, expect, test } from "vitest";
import {
  findIterateSecretReferences,
  replaceIterateSecretReferences,
} from "./iterate-secret-references.ts";

describe("iterate secret references", () => {
  test("finds raw secret references with double quotes", () => {
    expect(
      findIterateSecretReferences('Bearer getIterateSecret({secretKey: "openai_api_key"})'),
    ).toMatchObject([{ encoding: "raw", secretKey: "openai_api_key" }]);
  });

  test("finds raw secret references with single quotes", () => {
    expect(
      findIterateSecretReferences("Bearer getIterateSecret({secretKey: 'openai_api_key'})"),
    ).toMatchObject([{ encoding: "raw", secretKey: "openai_api_key" }]);
  });

  test("finds urlencoded secret references", () => {
    expect(
      findIterateSecretReferences(
        "Bearer getIterateSecret%28%7BsecretKey%3A%20%27openai_api_key%27%7D%29",
      ),
    ).toMatchObject([{ encoding: "urlencoded", secretKey: "openai_api_key" }]);
  });

  test("replaces every occurrence in a header value", async () => {
    const replaced = await replaceIterateSecretReferences({
      input: [
        "Bearer getIterateSecret({secretKey: 'alpha'})",
        "token=getIterateSecret%28%7BsecretKey%3A%20%27beta%27%7D%29",
      ].join(", "),
      loadSecret: async (secretKey) => `resolved:${secretKey}`,
    });

    expect(replaced.output).toContain("resolved:alpha");
    expect(replaced.output).toContain("resolved:beta");
    expect(replaced.secretKeys).toEqual(["alpha", "beta"]);
  });

  test("returns the original value when no magic string exists", async () => {
    const replaced = await replaceIterateSecretReferences({
      input: "Bearer plain-token",
      loadSecret: async (secretKey) => `resolved:${secretKey}`,
    });

    expect(replaced.output).toBe("Bearer plain-token");
    expect(replaced.secretKeys).toEqual([]);
  });

  test("throws when the magic string is malformed", () => {
    expect(() => findIterateSecretReferences("Bearer getIterateSecret({secretKey:oops})")).toThrow(
      /Malformed getIterateSecret reference/,
    );
  });
});
