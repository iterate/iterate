import { describe, expect, it } from "vitest";
import { DurableObjectNameCodec, resolveDurableObjectName } from "./durable-object-names.ts";

function identityContext(args: { name?: string; values?: Map<string, unknown> }) {
  const values = args.values ?? new Map<string, unknown>();
  const ctx = {
    id: { name: args.name },
    storage: {
      kv: {
        get: <T>(key: string) => values.get(key) as T | undefined,
        put: (key: string, value: unknown) => void values.set(key, value),
      },
    },
  } as unknown as Parameters<typeof resolveDurableObjectName>[0];
  return { ctx, values };
}

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
      DurableObjectNameCodec.stringify(
        { projectId: null, path: "/repos/iterate-config-base" },
        { allowNullProjectId: true },
      ),
    ).toBe("global.iterate/repos/iterate-config-base");
  });

  it("parses URL-shaped names back into parts", () => {
    expect(DurableObjectNameCodec.parse("prj_123.iterate/repos/repo_123")).toEqual({
      projectId: "prj_123",
      path: "/repos/repo_123",
      props: {},
    });
  });

  it("parses the global host back to null projectId", () => {
    expect(
      DurableObjectNameCodec.parse("global.iterate/repos/iterate-config-base", {
        allowNullProjectId: true,
      }),
    ).toEqual({
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
    const durableObjectName = DurableObjectNameCodec.stringify(input);
    expect(DurableObjectNameCodec.parse(durableObjectName)).toEqual({
      ...input,
      props: { slot: "a" },
    });
  });

  it("round-trips global names", () => {
    const input = { projectId: null, path: "/projects/catalog" };
    const durableObjectName = DurableObjectNameCodec.stringify(input, {
      allowNullProjectId: true,
    });
    expect(DurableObjectNameCodec.parse(durableObjectName, { allowNullProjectId: true })).toEqual({
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

  it("rejects null project ids unless global names are allowed", () => {
    const stringifyUnchecked = DurableObjectNameCodec.stringify as unknown as (input: {
      path: string;
      projectId: string | null;
    }) => string;
    expect(() => stringifyUnchecked({ projectId: null, path: "/" })).toThrow(/allowNullProjectId/);
  });

  it("rejects global names unless null project ids are allowed", () => {
    expect(() => DurableObjectNameCodec.parse("global.iterate/")).toThrow(/allowNullProjectId/);
  });
});

describe("resolveDurableObjectName", () => {
  it("persists a named activation and restores it for an ID-only reactivation", () => {
    const first = identityContext({ name: "prj_123.iterate/" });
    expect(resolveDurableObjectName(first.ctx)).toBe("prj_123.iterate/");

    const reactivated = identityContext({ values: first.values });
    expect(resolveDurableObjectName(reactivated.ctx)).toBe("prj_123.iterate/");
  });

  it("rejects a runtime name that disagrees with stored identity", () => {
    const first = identityContext({ name: "prj_123.iterate/" });
    resolveDurableObjectName(first.ctx);

    const mismatched = identityContext({ name: "prj_other.iterate/", values: first.values });
    expect(() => resolveDurableObjectName(mismatched.ctx)).toThrow(/identity mismatch/);
  });

  it("rejects an ID-only first activation with no canonical identity", () => {
    expect(() => resolveDurableObjectName(identityContext({}).ctx)).toThrow(
      /no canonical name was stored/,
    );
  });
});
