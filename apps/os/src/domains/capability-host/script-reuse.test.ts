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

test("locates each value's literal and swaps it for a generated alias, so names never collide with the script", () => {
  // `target` already appears in the script — with aliasing the caller can
  // still use it (live models pick the script's own variable name first).
  const result = reparameterizeScript({
    code: FACTORIZE,
    parameters: { target: 23409823948238439732889n },
  });
  expect(result.parameters).toEqual([{ name: "target", alias: "__reuse_target", kind: "bigint" }]);
  expect(result.code).toContain("const target = __reuse_target;");
  expect(result.code).not.toContain("23409823948238439732889");
});

test("aliases stay unique against the script text and each other, deterministically", () => {
  const result = reparameterizeScript({
    code: `async (itx) => __reuse_x + 7777n`,
    parameters: { x: 7777n },
  });
  expect(result.parameters).toEqual([{ name: "x", alias: "__reuse_x_2", kind: "bigint" }]);
  expect(result.code).toContain("__reuse_x + __reuse_x_2");
});

test("the value's literal must appear exactly once, with boundary-aware matching for bare literals", () => {
  expect(() =>
    reparameterizeScript({ code: FACTORIZE, parameters: { input: 998877n } }),
  ).toThrowError(/exactly once.*998877n \(0\)/s);
  expect(() =>
    reparameterizeScript({
      code: "async (itx) => 5n + 5n",
      parameters: { input: 5n },
    }),
  ).toThrowError(/2 total occurrence/);
  // 42 must not match inside 142, 42.5, or x42 — only the standalone literal.
  const result = reparameterizeScript({
    code: "async (itx) => 142 + 42.5 + x42 + 42",
    parameters: { answer: 42 },
  });
  expect(result.code).toBe("async (itx) => 142 + 42.5 + x42 + __reuse_answer");
});

test("underscore-grouped numeric spellings are chased", () => {
  const grouped = reparameterizeScript({
    code: "async (itx) => 1_000_000 + 1",
    parameters: { size: 1000000 },
  });
  expect(grouped.code).toBe("async (itx) => __reuse_size + 1");
  const groupedBigint = reparameterizeScript({
    code: "async (itx) => 52_479_543_428_582_704_627n",
    parameters: { n: 52479543428582704627n },
  });
  expect(groupedBigint.code).toBe("async (itx) => __reuse_n");
  // Canonical and grouped both present counts as ambiguous, with both
  // spellings named in the error.
  expect(() =>
    reparameterizeScript({
      code: "async (itx) => 1_000_000 + 1000000",
      parameters: { size: 1000000 },
    }),
  ).toThrowError(/1000000 \(1\), 1_000_000 \(1\) — 2 total/);
  // Short numbers must not double-count via a duplicate grouped spelling.
  const short = reparameterizeScript({
    code: "async (itx) => 42 + 1",
    parameters: { answer: 42 },
  });
  expect(short.code).toBe("async (itx) => __reuse_answer + 1");
});

test("string values match across quote styles, exactly once in total", () => {
  const result = reparameterizeScript({
    code: `async (itx) => itx.chat.sendMessage('hello world')`,
    parameters: { greeting: "hello world" },
  });
  expect(result.code).toBe(`async (itx) => itx.chat.sendMessage(__reuse_greeting)`);
  expect(() =>
    reparameterizeScript({
      code: "async (itx) => \"dup\" + 'dup'",
      parameters: { d: "dup" },
    }),
  ).toThrowError(/2 total occurrence/);
});

test("rejects invalid names, non-primitive values, and empty strings", () => {
  expect(() =>
    reparameterizeScript({ code: FACTORIZE, parameters: { "not valid": 1n } }),
  ).toThrowError(/not a valid JS identifier/);
  expect(() => reparameterizeScript({ code: FACTORIZE, parameters: { await: 1n } })) //
    .toThrowError(/not a valid JS identifier/);
  expect(() =>
    reparameterizeScript({ code: FACTORIZE, parameters: { obj: { nested: true } as any } }),
  ).toThrowError(/must be a string, number, boolean, or bigint/);
  expect(() => reparameterizeScript({ code: FACTORIZE, parameters: { s: "" } })) //
    .toThrowError(/empty string/);
});

describe("renderScriptReuseEnvelope", () => {
  const transformed = reparameterizeScript({
    code: FACTORIZE,
    parameters: { input: 23409823948238439732889n },
  });

  test("binds serialized vars to the aliases the swapped expressions read", () => {
    const envelope = renderScriptReuseEnvelope({
      ...transformed,
      vars: { input: 5489334582393292300937n },
    });
    expect(envelope).toContain("const __reuse_input = 5489334582393292300937n;");
    expect(envelope).toContain("const target = __reuse_input;");
    expect(envelope).toMatch(/^async \(itx: Itx\) => \{/);
    expect(envelope).toMatch(/return await __reusedScript\(itx\);\n\}$/);
  });

  test("vars must match the parameter names and each original value's primitive kind", () => {
    const render = (vars: any) => renderScriptReuseEnvelope({ ...transformed, vars });
    expect(() => render({})).toThrowError(/missing: \[input\]/);
    expect(() => render({ input: 1n, other: 2n })).toThrowError(/unexpected: \[other\]/);
    // The typecheck gate enforces this statically for agent scripts; the
    // runtime check covers runtimes without the gate (CLI, direct RPC).
    expect(() => render({ input: "5489334582393292300937n" })).toThrowError(
      /must be a bigint.*got string/,
    );
  });

  test("string vars serialize quoted and escaped", () => {
    const stringy = reparameterizeScript({
      code: `async (itx) => 'plain'`,
      parameters: { s: "plain" },
    });
    expect(renderScriptReuseEnvelope({ ...stringy, vars: { s: 'quo"te\n' } })).toContain(
      String.raw`const __reuse_s = "quo\"te\n";`,
    );
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
