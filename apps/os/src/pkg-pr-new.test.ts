import { expect, test } from "vitest";
import {
  parseIterateRepoPkgSpec,
  parseIterateRepoPkgSpecOverridesEnv,
  pinIterateRepoPkgRef,
} from "./pkg-pr-new.ts";

test("parses every published iterate/iterate URL shape", () => {
  expect(parseIterateRepoPkgSpec("https://pkg.pr.new/iterate/iterate/iterate@main")).toEqual({
    name: "iterate",
    ref: "main",
  });
  // Scoped names carry their own `@` — the ref is split on the LAST one.
  expect(
    parseIterateRepoPkgSpec("https://pkg.pr.new/iterate/iterate/@iterate-com/tasks@main"),
  ).toEqual({ name: "@iterate-com/tasks", ref: "main" });
  // Compact form: the package named after the repo.
  expect(parseIterateRepoPkgSpec("https://pkg.pr.new/iterate/iterate@1758")).toEqual({
    name: "iterate",
    ref: "1758",
  });
  const sha = "a".repeat(40);
  expect(parseIterateRepoPkgSpec(`https://pkg.pr.new/iterate/iterate/iterate@${sha}`)).toEqual({
    name: "iterate",
    ref: sha,
  });
});

test("anything that is not an iterate/iterate pkg.pr.new URL is not ours", () => {
  const foreign = [
    "^1.2.3",
    "https://registry.npmjs.org/iterate/-/iterate-1.0.0.tgz",
    "http://127.0.0.1:8080/iterate-abc123.tgz",
    "https://pkg.pr.new/tinylibs/tinybench/tinybench@main",
    "https://pkg.pr.new/iterate/other-repo/iterate@main",
    // Prefix collision: the repo segment must end at iterate/iterate.
    "https://pkg.pr.new/iterate/iterate-fork/pkg@main",
    // Ref-less and empty-ref URLs are not pinnable specs.
    "https://pkg.pr.new/iterate/iterate/iterate",
    "https://pkg.pr.new/iterate/iterate@",
  ];
  for (const spec of foreign) {
    expect(parseIterateRepoPkgSpec(spec)).toBe(null);
    expect(pinIterateRepoPkgRef(spec, "b".repeat(40))).toBe(null);
  }
});

test("pinning swaps only the ref and keeps the URL form", () => {
  const sha = "c0ffee".padEnd(40, "0");
  expect(pinIterateRepoPkgRef("https://pkg.pr.new/iterate/iterate/iterate@main", sha)).toBe(
    `https://pkg.pr.new/iterate/iterate/iterate@${sha}`,
  );
  expect(
    pinIterateRepoPkgRef("https://pkg.pr.new/iterate/iterate/@iterate-com/tasks@1758", sha),
  ).toBe(`https://pkg.pr.new/iterate/iterate/@iterate-com/tasks@${sha}`);
  expect(pinIterateRepoPkgRef("https://pkg.pr.new/iterate/iterate@main", sha)).toBe(
    `https://pkg.pr.new/iterate/iterate@${sha}`,
  );
});

test("spec-overrides env parsing: unset is undefined, malformed throws", () => {
  expect(parseIterateRepoPkgSpecOverridesEnv(undefined)).toBe(undefined);
  expect(parseIterateRepoPkgSpecOverridesEnv("  ")).toBe(undefined);
  expect(parseIterateRepoPkgSpecOverridesEnv("{}")).toBe(undefined);
  expect(
    parseIterateRepoPkgSpecOverridesEnv('{"iterate": "http://127.0.0.1:1234/iterate-abc.tgz"}'),
  ).toEqual({ iterate: "http://127.0.0.1:1234/iterate-abc.tgz" });
  expect(() => parseIterateRepoPkgSpecOverridesEnv('["iterate"]')).toThrow(/JSON object/);
  expect(() => parseIterateRepoPkgSpecOverridesEnv('{"iterate": 42}')).toThrow(/spec string/);
});
