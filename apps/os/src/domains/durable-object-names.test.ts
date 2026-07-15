import { describe, expect, test } from "vitest";
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
  test.for([
    {
      name: "encodes project-local stream coordinates",
      input: { projectId: "prj_123", path: "/repos/repo_123" },
      expected: "prj_123.iterate/repos/repo_123",
    },
    {
      name: "encodes optional props as query parameters",
      input: {
        projectId: "prj_123",
        path: "/repos/repo_123",
        props: { branch: "main", env: "prod" },
      },
      expected: "prj_123.iterate/repos/repo_123?branch=main&env=prod",
    },
    {
      name: "encodes null projectId as the global host",
      input: { projectId: null, path: "/repos/iterate-config-base" },
      options: { allowNullProjectId: true } as const,
      expected: "global.iterate/repos/iterate-config-base",
    },
  ])("$name", ({ input, options, expected }) => {
    expect(
      options === undefined
        ? DurableObjectNameCodec.stringify(input as { projectId: string; path: string })
        : DurableObjectNameCodec.stringify(input, options),
    ).toBe(expected);
  });

  test.for([
    {
      name: "parses URL-shaped names back into parts",
      input: "prj_123.iterate/repos/repo_123",
      expected: { projectId: "prj_123", path: "/repos/repo_123", props: {} },
    },
    {
      name: "parses the global host back to null projectId",
      input: "global.iterate/repos/iterate-config-base",
      options: { allowNullProjectId: true } as const,
      expected: { projectId: null, path: "/repos/iterate-config-base", props: {} },
    },
    {
      name: "parses query props back into a record",
      input: "prj_123.iterate/bla/bla?branch=main&env=prod",
      expected: { projectId: "prj_123", path: "/bla/bla", props: { branch: "main", env: "prod" } },
    },
  ])("$name", ({ input, options, expected }) => {
    expect(
      options === undefined
        ? DurableObjectNameCodec.parse(input)
        : DurableObjectNameCodec.parse(input, options),
    ).toEqual(expected);
  });

  test("round-trips formatted names", () => {
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

  test("round-trips global names", () => {
    const input = { projectId: null, path: "/projects/catalog" };
    const durableObjectName = DurableObjectNameCodec.stringify(input, {
      allowNullProjectId: true,
    });
    expect(DurableObjectNameCodec.parse(durableObjectName, { allowNullProjectId: true })).toEqual({
      ...input,
      props: {},
    });
  });

  test.for([
    {
      name: "rejects legacy colon-encoded names",
      act: () => DurableObjectNameCodec.parse("prj_123:/repos/project"),
      expected: /must be "\{projectId\}\.iterate"/,
    },
    {
      name: "rejects using global as a literal project id",
      act: () => DurableObjectNameCodec.stringify({ projectId: "global", path: "/repos/foo" }),
      expected: /reserved for deployment-wide/,
    },
    {
      name: "rejects names that exceed the Durable Object byte limit",
      act: () =>
        DurableObjectNameCodec.stringify({ projectId: "prj_123", path: `/${"a".repeat(300)}` }),
      expected: /at most 256 bytes/,
    },
    {
      name: "rejects null project ids unless global names are allowed",
      act: () =>
        (
          DurableObjectNameCodec.stringify as unknown as (input: {
            path: string;
            projectId: string | null;
          }) => string
        )({ projectId: null, path: "/" }),
      expected: /allowNullProjectId/,
    },
    {
      name: "rejects global names unless null project ids are allowed",
      act: () => DurableObjectNameCodec.parse("global.iterate/"),
      expected: /allowNullProjectId/,
    },
  ])("$name", ({ act, expected }) => {
    expect(act).toThrow(expected);
  });
});

describe("resolveDurableObjectName", () => {
  test("persists a named activation and restores it for an ID-only reactivation", () => {
    const first = identityContext({ name: "prj_123.iterate/" });
    expect(resolveDurableObjectName(first.ctx)).toBe("prj_123.iterate/");

    const reactivated = identityContext({ values: first.values });
    expect(resolveDurableObjectName(reactivated.ctx)).toBe("prj_123.iterate/");
  });

  test("rejects a runtime name that disagrees with stored identity", () => {
    const first = identityContext({ name: "prj_123.iterate/" });
    resolveDurableObjectName(first.ctx);

    const mismatched = identityContext({ name: "prj_other.iterate/", values: first.values });
    expect(() => resolveDurableObjectName(mismatched.ctx)).toThrow(/identity mismatch/);
  });

  test("rejects an ID-only first activation with no canonical identity", () => {
    expect(() => resolveDurableObjectName(identityContext({}).ctx)).toThrow(
      /no canonical name was stored/,
    );
  });
});
