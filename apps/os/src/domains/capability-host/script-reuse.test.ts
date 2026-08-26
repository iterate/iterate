import { describe, expect, test } from "vitest";
import { renderScriptReuseEnvelope, reparameterizeScript } from "./script-reuse.ts";

const FACTORIZE = `async (itx) => {
  const target = 23409823948238439732889n;
  let remaining = target;
  const factors = [];
  for (let candidate = 2n; candidate * candidate <= remaining; candidate++) {
    while (remaining % candidate === 0n) {
      factors.push(candidate);
      remaining /= candidate;
    }
  }
  if (remaining > 1n) factors.push(remaining);
  return factors.map(String);
}`;

test("swaps each parameter content for its name", () => {
  const result = reparameterizeScript({
    code: FACTORIZE,
    parameters: [{ name: "input", content: "23409823948238439732889n" }],
  });
  expect(result.parameterNames).toEqual(["input"]);
  expect(result.code).toContain("const target = input;");
  expect(result.code).not.toContain("23409823948238439732889");
});

test("content must appear exactly once", () => {
  expect(() =>
    reparameterizeScript({
      code: FACTORIZE,
      parameters: [{ name: "input", content: "998877n" }],
    }),
  ).toThrowError(/found 0 occurrence/);
  expect(() =>
    reparameterizeScript({
      code: FACTORIZE,
      parameters: [{ name: "input", content: "factors.push" }],
    }),
  ).toThrowError(/must appear exactly once/);
});

test("rejects names that are not identifiers, are reserved, repeat, or already appear in the script", () => {
  const parameters = (name: string) => [{ name, content: "23409823948238439732889n" }];
  expect(() => reparameterizeScript({ code: FACTORIZE, parameters: parameters("not valid") })) //
    .toThrowError(/not a valid JS identifier/);
  expect(() => reparameterizeScript({ code: FACTORIZE, parameters: parameters("await") })) //
    .toThrowError(/not a valid JS identifier/);
  expect(() => reparameterizeScript({ code: FACTORIZE, parameters: parameters("remaining") })) //
    .toThrowError(/already appears in the script/);
  expect(() =>
    reparameterizeScript({
      code: FACTORIZE,
      parameters: [
        { name: "input", content: "23409823948238439732889n" },
        { name: "input", content: "2n" },
      ],
    }),
  ).toThrowError(/appears more than once/);
});

describe("renderScriptReuseEnvelope", () => {
  const transformed = reparameterizeScript({
    code: FACTORIZE,
    parameters: [{ name: "input", content: "23409823948238439732889n" }],
  });

  test("wraps the script so parameter names close over serialized vars", () => {
    const envelope = renderScriptReuseEnvelope({
      ...transformed,
      vars: { input: 5489334582393292300937n },
    });
    expect(envelope).toContain("const input = 5489334582393292300937n;");
    expect(envelope).toContain("const target = input;");
    expect(envelope).toMatch(/^async \(itx: Itx\) => \{/);
    expect(envelope).toMatch(/return await __reusedScript\(itx\);\n\}$/);
  });

  test("serializes JSON-style values plus bigint; rejects everything else", () => {
    const render = (vars: any) =>
      renderScriptReuseEnvelope({ code: "async (itx) => v", parameterNames: ["v"], vars });
    expect(render({ v: { a: [1, "two", true, null, 3n] } })).toContain(
      `const v = { "a": [1, "two", true, null, 3n] };`,
    );
    expect(() => render({ v: new Date() })).toThrowError(/JSON-style values/);
    expect(() => render({ v: () => 1 })).toThrowError(/JSON-style values/);
  });

  test("vars must exactly match parameter names", () => {
    const render = (vars: any) => renderScriptReuseEnvelope({ ...transformed, vars });
    expect(() => render({})).toThrowError(/missing: \[input\]/);
    expect(() => render({ input: 1n, other: 2n })).toThrowError(/unexpected: \[other\]/);
  });

  test("the rendered envelope is executable and produces the reused script's behavior", async () => {
    const envelope = renderScriptReuseEnvelope({
      ...transformed,
      vars: { input: 15n },
    });
    // Strip the two type annotations the same way the typecheck gate's emit
    // would, then run it — proving the shape is a valid script.
    const js = envelope
      .replace("async (itx: Itx) =>", "async (itx) =>")
      .replace(
        "const __reusedScript: (itx: Itx, ...rest: any[]) => unknown =",
        "const __reusedScript =",
      );
    const module = await import(`data:text/javascript,export default (${encodeURIComponent(js)})`);
    const fn = module.default as (itx: unknown) => Promise<string[]>;
    await expect(fn({})).resolves.toEqual(["3", "5"]);
  });
});
