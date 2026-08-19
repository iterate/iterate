// BUG-HUNT SPEC for the expression codec (parse/print/match/evaluate/apply/invokePath).
// Every test asserts CORRECT behavior. `test.fails(...)` marks a case VERIFIED failing today
// (each such body opens with BUG/EXPECTED/ACTUAL/WHY IT MATTERS). Plain `test(...)` cases pass
// and document behavior that is already correct. No production code is touched.
import { describe, expect, test } from "vitest";
import {
  apply,
  evaluate,
  invokePath,
  match,
  parse,
  parseCapabilityPath,
  print,
  type Expression,
} from "./expression.ts";

// ─────────────────────────── round-trip: numbers ───────────────────────────

describe("parse ⇄ print — numbers", () => {
  test("negatives and decimals round-trip", () => {
    for (const n of [-5, -5.5, 0, 42, 3.14, -0.001, 1000000]) {
      expect(parse(print(["itx", ["f", n]]))).toEqual(["itx", ["f", n]]);
    }
  });

  test.fails("exponent-form numbers do NOT round-trip", () => {
    // BUG: `print` renders large/small numbers with `JSON.stringify`, which emits exponent form
    //      (`1e+21`, `1e-7`) for |n| ≥ 1e21 or < 1e-6, but the parser's #number regex is
    //      /^-?\d+(\.\d+)?/ — it has no exponent branch.
    // EXPECTED: parse(print(e)) === e for every number the codec can hold (the documented
    //      "parse(print(e)) round-trips" contract at the top of expression.ts / print's docstring).
    // ACTUAL: print([["f", 1e21]]) => "itx.f(1e+21)"; parse("itx.f(1e+21)") THROWS
    //      `expected ")"` at the `e`. Same for 1e-7 => "itx.f(1e-7)".
    // WHY IT MATTERS: this is a persisted STRING-AT-REST codec. A mount/expression carrying a big
    //      or tiny number literal is written by print, then re-read by parse on every reduce — the
    //      value becomes unparseable at rest (see the capability-table sibling test where such a
    //      mount is silently dropped as "malformed").
    for (const n of [1e21, 1e-7, -1e21, 1.5e300]) {
      expect(parse(print(["itx", ["f", n]]))).toEqual(["itx", ["f", n]]);
    }
  });

  test.fails("negative zero is lost on the round-trip", () => {
    // BUG: the parser accepts and PRODUCES -0 (Number("-0") === -0), but print emits
    //      JSON.stringify(-0) === "0", so re-parsing yields +0.
    // EXPECTED: a value parse can produce must survive parse(print(x)) unchanged.
    // ACTUAL: parse("itx.f(-0)") holds -0; print(...) => "itx.f(0)"; the re-parse holds +0.
    // WHY IT MATTERS: print/parse are advertised as inverse. A literal parse can create but print
    //      cannot reproduce is an asymmetry — the codec is not actually a bijection over its own
    //      accepted inputs.
    const original = parse("itx.f(-0)");
    expect(Object.is((original[1] as [string, number])[1], -0)).toBe(true); // parse preserved -0
    const round = parse(print(original));
    expect(Object.is((round[1] as [string, number])[1], -0)).toBe(true); // ← round-trip flipped it to +0
  });
});

// ─────────────────────────── round-trip: object keys ───────────────────────────

describe("parse ⇄ print — object literals", () => {
  test("identifier and kebab keys round-trip", () => {
    for (const key of ["foo", "user-tally", "a1", "$x", "_y"]) {
      const e = ["itx", ["f", { [key]: 1 }]] as Expression;
      expect(parse(print(e))).toEqual(e);
    }
  });

  test("constructor / prototype are ordinary DATA keys (no pollution, they round-trip)", () => {
    // These are NOT special as object keys — only __proto__ triggers the setter. They store and
    // reprint as plain own properties.
    const e = ["itx", ["f", { constructor: 1, prototype: 2 }]] as Expression;
    const obj = (parse(print(e))[1] as [string, Record<string, unknown>])[1];
    expect(obj).toEqual({ constructor: 1, prototype: 2 });
    expect(Object.keys(obj)).toEqual(["constructor", "prototype"]);
  });

  test.fails("object keys that are not identifiers do NOT round-trip", () => {
    // BUG: printValue emits object keys RAW (`${k}: ${printValue(val)}`), never quoting them, but
    //      #object only reads an unquoted key via #word (an identifier regex). A key with a space,
    //      a dot, or a leading digit prints unquoted and cannot be re-parsed.
    // EXPECTED: parse(print(e)) === e for any object value (keys are arbitrary strings).
    // ACTUAL: print([["f", {"a b": 1}]]) => "itx.f({ a b: 1 })"; parse THROWS `expected ":"`.
    //      Same for {"a.b":1} => "{ a.b: 1 }" and {"3d":1} => "{ 3d: 1 }".
    // WHY IT MATTERS: real mount/expression args carry structured objects; any non-identifier key
    //      (an HTTP header "content-type" is fine — hyphens survive — but "x y", "a.b", or a
    //      numeric-leading key is not) makes the persisted string unparseable.
    for (const key of ["a b", "a.b", "3d"]) {
      const e = ["itx", ["f", { [key]: 1 }]] as Expression;
      expect(parse(print(e))).toEqual(e);
    }
  });

  // FIXED (defect 4): #object stores keys via Object.defineProperty — a "__proto__" key is
  // an own data property, never the prototype setter. Regression guard.
  test("a __proto__ key in a payload is an own property, not prototype pollution", () => {
    // BUG: #object writes keys with `out[key] = value`. For key "__proto__" that invokes the
    //      prototype SETTER, not a data write. #ident/stepGet treat __proto__/constructor/prototype
    //      as reserved, but #object does NOT — the object-literal door is unguarded.
    // EXPECTED: parsing a data payload must never mutate an object's prototype. Either reject
    //      "__proto__" as a reserved key (consistent with #ident) or store it as an own data
    //      property — but the resulting object's prototype must stay Object.prototype.
    // ACTUAL: parse("itx.f({ __proto__: { polluted: true } })") returns an object whose PROTOTYPE
    //      is `{ polluted: true }` — obj.polluted === true, Object.getPrototypeOf(obj) !==
    //      Object.prototype, and the key is not an own property. (The number form { __proto__: 1 }
    //      silently DROPS the key instead — a no-op setter.)
    // WHY IT MATTERS: expression payloads are attacker-influenced strings at rest; this is a
    //      prototype-pollution primitive smuggled through the codec (and the parsed object then
    //      flows into apply()/substitution/handlers as if it were clean JSON).
    const obj = (
      parse("itx.f({ __proto__: { polluted: true } })")[1] as [string, Record<string, unknown>]
    )[1];
    expect(Object.getPrototypeOf(obj)).toBe(Object.prototype); // ← prototype was replaced
    expect(obj.polluted).toBeUndefined(); // ← reads `true` through the polluted prototype
  });
});

// ─────────────────────────── round-trip: strings & nesting (already correct) ───────────────────────────

describe("parse ⇄ print — strings and depth", () => {
  test("a string containing BOTH quote kinds round-trips", () => {
    for (const str of [`he said "hi"`, `it's "cool"`, `'`, `"`, `both ' and "`]) {
      const e = ["itx", ["f", str]] as Expression;
      expect(parse(print(e))).toEqual(e);
    }
  });

  test("backslash, newline and tab inside strings round-trip", () => {
    for (const str of [`\\`, `a\\b`, `line1\nline2`, `col1\tcol2`, `\\n literal`]) {
      const e = ["itx", ["f", str]] as Expression;
      expect(parse(print(e))).toEqual(e);
    }
  });

  test("empty-string arguments round-trip", () => {
    expect(parse("itx.f('')")).toEqual(["itx", ["f", ""]]);
    expect(parse(print(["itx", ["f", ""]]))).toEqual(["itx", ["f", ""]]);
  });

  test("depth budget boundary: 64 nested levels parse, 65 is a loud error (not a stack overflow)", () => {
    const nest = (n: number) => `itx.f(${"[".repeat(n)}${"]".repeat(n)})`;
    expect(() => parse(nest(64))).not.toThrow();
    expect(() => parse(nest(65))).toThrow(/nesting exceeds/);
  });
});

// ─────────────────────────── evaluate / apply / invokePath (already correct) ───────────────────────────

describe("evaluate / apply / invokePath", () => {
  test("invokePath propagates a throwing getter instead of swallowing it", async () => {
    const target = {
      a: {
        get b() {
          throw new Error("getter-boom");
        },
      },
      m: {
        run: () => "ok",
      },
    };
    // the terminal segment reads b via stepGet → the getter throws → the walk rejects loudly
    await expect(invokePath(target, ["a", "b"], [], "test")).rejects.toThrow(/getter-boom/);
    // a middle segment getter throwing is equally loud
    await expect(invokePath(target, ["a", "b", "whatever"], [], "test")).rejects.toThrow(
      /getter-boom/,
    );
    // sanity: the callable path still works
    expect(await invokePath(target, ["m", "run"], [], "test")).toBe("ok");
  });

  test("boundary args on a non-callable target are a LOUD error (no silent arg drop)", async () => {
    const scope = { itx: { db: { some: "value" } } };
    const m = match(parseCapabilityPath("itx.x"), parse("itx.x('oops')"))!;
    await expect(apply(scope, parse("itx.db"), m)).rejects.toThrow(/not callable/);
  });

  test("evaluate refuses a root that is not in scope (the provenance gate)", async () => {
    await expect(evaluate({ itx: {} }, parse("builtins.kv.get('x')"))).rejects.toThrow(
      /not in scope/,
    );
  });
});
