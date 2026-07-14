import { describe, expect, it } from "vitest";
import { stripScriptTypes } from "./script-type-stripping.ts";

// Scripts are promised as TypeScript but the bundle-free fast path loads
// plain JavaScript — stripScriptTypes is the seam that honors the promise.
// Live prd incident (2026-07-14 pirate thread): `(r: any, i: number) =>`
// passed the execution gate (script.ts accepts annotations) and crashed the
// runtime with a bare "Unexpected token ':'".
describe("stripScriptTypes", () => {
  it("strips the incident script's parameter annotations", () => {
    const code = `async (itx) => {\n  const hits = [1, 2].map((r: any, i: number) => ({ r, i }));\n  return hits;\n}`;
    const stripped = stripScriptTypes(code);
    expect(stripped).not.toContain(": any");
    expect(stripped).not.toContain(": number");
    // Still a callable arrow function with the same body semantics.
    // oxlint-disable-next-line no-new-func
    const fn = new Function(`return (${stripped})`)() as (x: unknown) => Promise<unknown>;
    return expect(fn(null)).resolves.toEqual([
      { r: 1, i: 0 },
      { r: 2, i: 1 },
    ]);
  });

  it("strips as-casts, generics, and interfaces", () => {
    const stripped = stripScriptTypes(
      `async (itx) => {\n  interface X { a: number }\n  const v = { a: 1 } as X;\n  const arr: Array<number> = [v.a];\n  return arr;\n}`,
    );
    expect(stripped).not.toContain("interface");
    expect(stripped).not.toContain(" as X");
  });

  it("leaves plain JavaScript byte-identical", () => {
    const code = `async (itx) => {\n  const hits = [1, 2].map((r, i) => ({ r, i }));\n  return hits;\n}`;
    expect(stripScriptTypes(code)).toBe(code);
  });

  it("passes unparseable code through raw (the loader's error feeds the corrective lane)", () => {
    const broken = "async (itx) => { retur n 1; }";
    expect(stripScriptTypes(broken)).toBe(broken);
  });
});
