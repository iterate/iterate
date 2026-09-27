// Tests for iterate/prefer-logical-and-spread: object spread treats any falsy
// value like {}, so `...(cond ? obj : {})` is just `...(cond && obj)` with a
// dead empty-object arm. The rule is auto-fixable, and the fix must be
// parse-preserving (parens around `||`/`??`/ternary operands). Each row runs
// the real oxlint binary with --fix: what it still reports, and the file after.

import { expect, test } from "vitest";
import { lintOne } from "./oxlint-fixture.ts";

test.for([
  {
    name: "fixes the basic pattern",
    source: `
      declare const f: { def: string } | undefined;
      export const x = {
        ...(f ? { abc: f.def } : {}),
      };
    `,
    fixed: `
      declare const f: { def: string } | undefined;
      export const x = {
        ...(f && { abc: f.def }),
      };
    `,
    reports: [],
  },
  {
    name: "parenthesizes operands that bind looser than &&",
    source: `
      declare const a: boolean, b: boolean, f: boolean;
      declare const left: object | null, right: object;
      export const x = {
        ...(a || b ? { x: 1 } : {}),
        ...(f ? (left ?? right) : {}),
      };
    `,
    fixed: `
      declare const a: boolean, b: boolean, f: boolean;
      declare const left: object | null, right: object;
      export const x = {
        ...((a || b) && { x: 1 }),
        ...(f && (left ?? right)),
      };
    `,
    reports: [],
  },
  {
    name: "fixes non-literal consequents too",
    source: `
      declare const f: { extras: object } | undefined;
      export const x = {
        ...(f ? f.extras : {}),
      };
    `,
    fixed: `
      declare const f: { extras: object } | undefined;
      export const x = {
        ...(f && f.extras),
      };
    `,
    reports: [],
  },
  {
    name: "reports without fixing when the rewrite would drop a comment",
    source: `
      declare const f: { def: string } | undefined;
      export const x = {
        ...(f ? /* keep me */ { abc: f.def } : {}),
      };
    `,
    reports: ["Spreading a falsy value"],
  },
  {
    // Both arms meaningful; the mirrored form (its fix would add a negation); already idiomatic;
    // an array spread, where spreading a falsy value throws.
    name: "leaves non-matching spreads alone",
    source: `
      declare const f: boolean, g: { a: number };
      export const objects = {
        ...(f ? { a: 1 } : { b: 2 }),
        ...(f ? {} : { a: 1 }),
        ...(f && g),
      };
      export const array = [...(f ? [1] : [])];
    `,
    reports: [],
  },
])("$name", ({ source, fixed = source, reports }) => {
  expect(lintOne("prefer-logical-and-spread", "input.ts", source)).toEqual({
    messages: reports.map((opening) => expect.stringContaining(opening)),
    output: fixed,
  });
});
