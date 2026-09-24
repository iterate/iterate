import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { nextBaseline } from "./grandfather-baseline.ts";
import { grandfatheredRules, readBaseline, type GrandfatheredLines } from "./grandfather-rule.ts";
import plugin from "./oxlint-plugin-iterate.ts";

test("grandfathers the listed lines wherever they move, and checks every other line", () => {
  using fixture = createFixture({ "fixture/old": { "input.ts": ["const BAD_OLD = 1;"] } });
  fixture.write("// inserted above\nconst BAD_OLD = 1;\nconst BAD_NEW = 2;\n");
  expect(fixture.lint()).toMatchObject({ status: 1, names: ["BAD_NEW"], stale: false });
});

test("each entry covers one report, so a copied violation is new", () => {
  using fixture = createFixture({ "fixture/old": { "input.ts": ["const BAD_OLD = 1;"] } });
  fixture.write("const BAD_OLD = 1;\n{\n  const BAD_OLD = 1;\n}\n");
  expect(fixture.lint()).toMatchObject({ status: 1, names: ["BAD_OLD"], stale: false });
});

test("an edited line is new, and its entry is stale until pnpm lint:baseline drops it", () => {
  using fixture = createFixture({ "fixture/old": { "input.ts": ["const BAD_OLD = 1;"] } });
  fixture.write("const BAD_OLD = 2;\n");
  expect(fixture.lint()).toMatchObject({ status: 1, names: ["BAD_OLD"], stale: true });
  fixture.write("const goodOLD = 1;\n");
  expect(fixture.lint()).toMatchObject({ status: 1, names: [], stale: true });
});

test("an entry covers only its own rule and file", () => {
  using fixture = createFixture({ "fixture/old": { "input.ts": ["const BAD_OLD = 1;"] } });
  fixture.write("const BAD_OLD = 1;\n");
  writeFileSync(join(fixture.root, "other.ts"), "const BAD_OLD = 1;\n");
  fixture.armStrictRule();
  const { status, output, names } = fixture.lint(["input.ts", "other.ts"]);
  expect({
    status,
    names,
    strict: [...output.matchAll(/Strict (BAD_\w+)/g)].map((match) => match[1]),
  }).toEqual({ status: 1, names: ["BAD_OLD"], strict: ["BAD_OLD", "BAD_OLD"] });
});

test("uses explicit report locations before node locations, including location-only reports", () => {
  using fixture = createFixture({
    "fixture/old": { "input.ts": ["const BAD_A = 1;", "const BAD_A = 1;"] },
  });
  fixture.write("const BAD_A = 1;\nconst BAD_B = 2;\n");
  const source = readFileSync(fixture.plugin, "utf8");
  writeFileSync(
    fixture.plugin,
    source.replace("{ node, messageId:", "{ node, loc: { line: 1, column: 0 }, messageId:"),
  );
  expect(fixture.lint()).toMatchObject({ status: 0, names: [], stale: false });
  writeFileSync(
    fixture.plugin,
    source.replace(
      "{ node, messageId:",
      "{ loc: { start: { line: 2, column: 0 }, end: { line: 2, column: 5 } }, messageId:",
    ),
  );
  expect(fixture.lint()).toMatchObject({ status: 1, names: ["BAD_A", "BAD_B"], stale: true });
});

test("keeps rule metadata and fixes, fixing only new violations", () => {
  using fixture = createFixture({ "fixture/old": { "input.ts": ["const BAD_OLD = 1;"] } });
  fixture.write("const BAD_OLD = 1;\nconst BAD_NEW = 2;\n");
  expect(fixture.lint(["input.ts", "--fix"])).toMatchObject({ status: 0, names: [] });
  expect(readFileSync(fixture.file, "utf8")).toBe("const BAD_OLD = 1;\nconst goodNEW = 2;\n");
});

test("pnpm lint:baseline's report-all mode reports grandfathered violations and no stale entries", () => {
  using fixture = createFixture({
    "fixture/old": { "input.ts": ["const BAD_OLD = 1;", "const BAD_GONE = 1;"] },
  });
  fixture.write("const BAD_OLD = 1;\n");
  expect(fixture.lint(["input.ts"], { LINT_BASELINE_REPORT_ALL: "1" })).toMatchObject({
    status: 1,
    names: ["BAD_OLD"],
    stale: false,
  });
});

test("pnpm lint:baseline only drops entries, each kept by at most one current report", () => {
  const previous = {
    "iterate/a": { "x.ts": ["copy", "copy", "gone"], "deleted.ts": ["old"] },
    "iterate/b": { "x.ts": ["kept"] },
  };
  const current = {
    "iterate/a": { "x.ts": ["copy", "new"], "y.ts": ["new"] },
    "iterate/b": { "x.ts": ["kept", "kept"] },
    "iterate/c": { "z.ts": ["new", "armed"] },
  };
  expect(nextBaseline(previous, current, [])).toEqual({
    "iterate/a": { "x.ts": ["copy"] },
    "iterate/b": { "x.ts": ["kept"] },
  });
  expect(nextBaseline(previous, current, ["iterate/c"])).toMatchObject({
    "iterate/c": { "z.ts": ["armed", "new"] },
  });
});

test("the repository baseline lists debt for exactly the grandfathered rules, in files that exist", () => {
  const { root, lines } = readBaseline();
  const grandfathered = Object.entries(plugin.rules)
    .filter(([, rule]) => grandfatheredRules.has(rule))
    .map(([name]) => `iterate/${name}`);
  // A rule whose debt reaches zero drops its grandfatherRule wrapper: lint/grandfather-rule.md.
  expect(Object.keys(lines).sort()).toEqual(grandfathered.sort());
  expect(
    Object.values(lines)
      .flatMap((files) => Object.keys(files))
      .filter((path) => !existsSync(join(root, path))),
  ).toEqual([]);
});

const repoRoot = resolve(import.meta.dirname, "..");

function createFixture(baseline: GrandfatheredLines) {
  const root = mkdtempSync(join(tmpdir(), "grandfather-rule-"));
  const file = join(root, "input.ts");
  const plugin = join(root, "plugin.ts");
  writeFileSync(join(root, "grandfathered.json"), JSON.stringify(baseline));
  writeFileSync(
    plugin,
    `
    import { readFileSync } from "node:fs";
    import { grandfatherRule } from ${JSON.stringify(join(repoRoot, "lint/grandfather-rule.ts"))};
    const baseline = {
      root: ${JSON.stringify(root)},
      lines: JSON.parse(readFileSync(${JSON.stringify(join(root, "grandfathered.json"))}, "utf8")),
    };
    const report = (message) => (context) => ({ Identifier(node) {
      if (node.name.startsWith("BAD_")) context.report({ node, message: message + " " + node.name });
    } });
    export default {
      meta: { name: "fixture" },
      rules: {
        strict: { create: report("Strict") },
        old: grandfatherRule({
          meta: { type: "suggestion", fixable: "code", messages: { banned: "Found {{name}}" } },
          create(context) {
            return { Identifier(node) {
              if (!node.name.startsWith("BAD_")) return;
              context.report({ node, messageId: "banned", data: { name: node.name },
                fix(fixer) { return fixer.replaceText(node, "good" + node.name.slice(4)); }
              });
            } };
          }
        }, baseline),
      },
    };
  `,
  );
  const config = join(root, ".oxlintrc.json");
  const rules: Record<string, string> = { "fixture/old": "error" };
  const writeConfig = () =>
    writeFileSync(
      config,
      JSON.stringify({ categories: { correctness: "off" }, jsPlugins: [plugin], rules }),
    );
  writeConfig();
  return {
    root,
    file,
    plugin,
    write(contents: string) {
      writeFileSync(file, contents);
    },
    armStrictRule() {
      rules["fixture/strict"] = "error";
      writeConfig();
    },
    lint(args = ["input.ts"], env: Record<string, string> = {}) {
      const result = spawnSync(
        join(repoRoot, "node_modules/.bin/oxlint"),
        [...args, "--config", config, "--threads", "1"],
        { cwd: root, encoding: "utf8", env: { ...process.env, ...env } },
      );
      const output = result.stdout + result.stderr;
      return {
        status: result.status,
        names: [...output.matchAll(/Found (BAD_\w+)/g)].map((match) => match[1]),
        stale: output.includes("that no longer occur. Run `pnpm lint:baseline`"),
        output,
      };
    },
    [Symbol.dispose]() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
