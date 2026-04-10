import type { CodemodeInput } from "@iterate-com/codemode-contract";
import { describe, expect, test } from "vitest";
import {
  buildCodemodeWrapperSource,
  CODEMODE_EXAMPLES,
  CODEMODE_V2_STARTER,
} from "~/lib/codemode-v2.ts";

describe("buildCodemodeWrapperSource", () => {
  test("wraps the user function with the injected nested ctx object", () => {
    const source = buildCodemodeWrapperSource({
      userCode: "async ({ ctx }) => ctx.example.ping({})",
      sandboxPrelude:
        'const ctx = { "example": { "ping": (input) => rpc.example__ping(input ?? {}) } };',
    });

    expect(source).toContain("const ctx = {");
    expect(source).toContain('"example": { "ping": (input) => rpc.example__ping(input ?? {}) }');
    expect(source).toContain("const userFn = (async ({ ctx }) => ctx.example.ping({}))");
    expect(source).toContain("return await userFn({ ctx });");
  });

  test("ships a starter that uses the deterministic function shape", () => {
    expect(CODEMODE_V2_STARTER.startsWith("async ({ ctx }) => {")).toBe(true);
    expect(CODEMODE_V2_STARTER).toContain("ctx.events.append");
    expect(CODEMODE_V2_STARTER).toContain("ctx.semaphore.resources.list");
    expect(CODEMODE_V2_STARTER).toContain("ctx.ingressProxy.routes.list");
  });

  test("includes a package-project OpenAI example", () => {
    const example = CODEMODE_EXAMPLES.find(({ id }) => id === "openai-package-project");
    const input = example?.input as Extract<CodemodeInput, { type: "package-project" }>;

    expect(example).toBeDefined();
    expect(example?.title).toBe("OpenAI Package Project");
    expect(input.type).toBe("package-project");
    expect(input.files["package.json"]).toContain('"openai": "^6.0.0"');
    expect(input.files["src/index.ts"]).toContain(
      'getIterateSecret({ secretKey: "openai.apiKey" })',
    );
    expect(input.files["src/index.ts"]).toContain("client.responses.create");
  });
});
