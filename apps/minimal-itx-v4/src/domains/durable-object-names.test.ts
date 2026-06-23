import { describe, expect, it } from "vitest";
import { DurableObjectNameCodec } from "./durable-object-names.ts";

describe("DurableObjectNameCodec", () => {
  it("encodes project-local stream coordinates", () => {
    expect(
      DurableObjectNameCodec.stringify({ projectId: "prj_123", path: "/repos/repo_123" }),
    ).toBe("prj_123.iterate/repos/repo_123");
  });

  it("encodes optional props as query parameters", () => {
    expect(
      DurableObjectNameCodec.stringify({
        projectId: "prj_123",
        path: "/repos/repo_123",
        props: { branch: "main", env: "prod" },
      }),
    ).toBe("prj_123.iterate/repos/repo_123?branch=main&env=prod");
  });

  it("encodes null projectId as the global host", () => {
    expect(
      DurableObjectNameCodec.stringify({ projectId: null, path: "/repos/iterate-config-base" }),
    ).toBe(`${DurableObjectNameCodec.globalHost}.iterate/repos/iterate-config-base`);
  });

  it("parses URL-shaped names back into parts", () => {
    expect(DurableObjectNameCodec.parse("prj_123.iterate/repos/repo_123")).toEqual({
      projectId: "prj_123",
      path: "/repos/repo_123",
      props: {},
    });
  });

  it("parses the global host back to null projectId", () => {
    expect(DurableObjectNameCodec.parse("global.iterate/repos/iterate-config-base")).toEqual({
      projectId: null,
      path: "/repos/iterate-config-base",
      props: {},
    });
  });

  it("parses query props back into a record", () => {
    expect(DurableObjectNameCodec.parse("prj_123.iterate/bla/bla?branch=main&env=prod")).toEqual({
      projectId: "prj_123",
      path: "/bla/bla",
      props: { branch: "main", env: "prod" },
    });
  });

  it("round-trips formatted names", () => {
    const input = {
      projectId: "prj_123",
      path: "/agents/onboarding",
      props: { slot: "a" },
    };
    expect(DurableObjectNameCodec.parse(DurableObjectNameCodec.stringify(input))).toEqual({
      ...input,
      props: { slot: "a" },
    });
  });

  it("round-trips global names", () => {
    const input = { projectId: null, path: "/projects/catalog" };
    expect(DurableObjectNameCodec.parse(DurableObjectNameCodec.stringify(input))).toEqual({
      ...input,
      props: {},
    });
  });

  it("rejects legacy colon-encoded names", () => {
    expect(() => DurableObjectNameCodec.parse("prj_123:/repos/project")).toThrow(
      /must be "\{projectId\}\.iterate"/,
    );
  });

  it("rejects using global as a literal project id", () => {
    expect(() =>
      DurableObjectNameCodec.stringify({ projectId: "global", path: "/repos/foo" }),
    ).toThrow(/reserved for deployment-wide/);
  });

  it("rejects names that exceed the Durable Object byte limit", () => {
    const longPath = `/${"a".repeat(300)}`;
    expect(() =>
      DurableObjectNameCodec.stringify({ projectId: "prj_123", path: longPath }),
    ).toThrow(/at most 256 bytes/);
  });

  it("parseProjectScoped rejects global names", () => {
    expect(() => DurableObjectNameCodec.parseProjectScoped("global.iterate/")).toThrow(
      /must be project-scoped/,
    );
  });
});
