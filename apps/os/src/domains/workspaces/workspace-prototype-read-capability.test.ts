import { describe, expect, test } from "vitest";
import {
  signPrototypeBlobRead,
  verifyPrototypeBlobRead,
} from "./workspace-prototype-read-capability.ts";

const grant = {
  containerId: "container-a",
  projectId: "project-a",
  repoPath: "/repos/source",
  oid: "a".repeat(40),
  expiresAt: 2000,
};

describe("prototype immutable read capability", () => {
  test("binds the exact repository/blob to the actual container and deadline", () => {
    const token = signPrototypeBlobRead("test-secret", grant);
    expect(verifyPrototypeBlobRead("test-secret", token, grant, "container-a", 1999)).toEqual(
      grant,
    );
    expect(verifyPrototypeBlobRead("test-secret", token, grant, "container-b", 1999)).toBeNull();
    expect(
      verifyPrototypeBlobRead(
        "test-secret",
        token,
        { ...grant, containerId: "container-b" },
        "container-b",
        1999,
      ),
    ).toBeNull();
    expect(verifyPrototypeBlobRead("test-secret", token, grant, "container-a", 2000)).toBeNull();
    expect(verifyPrototypeBlobRead("another-secret", token, grant, "container-a", 1999)).toBeNull();
  });

  test("rejects changing any grant field, malformed tokens, and invalid grant data", () => {
    const token = signPrototypeBlobRead("test-secret", grant);
    for (const change of [
      { projectId: "project-b" },
      { repoPath: "/repos/other" },
      { oid: "b".repeat(40) },
      { expiresAt: 999999 },
    ]) {
      expect(
        verifyPrototypeBlobRead("test-secret", token, { ...grant, ...change }, "container-a", 1000),
      ).toBeNull();
    }
    for (const value of [
      "",
      "a",
      "a.b",
      `${token}.extra`,
      "a".repeat(2049),
      signPrototypeBlobRead("test-secret", { ...grant, oid: "not-an-oid" }),
    ]) {
      expect(verifyPrototypeBlobRead("test-secret", value, grant, "container-a", 1000)).toBeNull();
    }
    const invalid = { ...grant, oid: "not-an-oid" };
    expect(
      verifyPrototypeBlobRead(
        "test-secret",
        signPrototypeBlobRead("test-secret", invalid),
        invalid,
        "container-a",
        1000,
      ),
    ).toBeNull();
  });
});
