import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { grandfatherRule } from "./grandfather-rule.ts";

test("grandfathers through the inclusive author-date cutoff, despite shifted line numbers", () => {
  using fixture = createFixture();
  fixture.write("const BAD_OLD = 1;\n");
  fixture.commit("2020-01-01T00:00:00Z");
  fixture.write("const BAD_OLD = 1;\nconst BAD_BOUNDARY = 2;\n");
  fixture.commit("2021-01-01T00:00:00Z");
  fixture.write(
    "// inserted above old declarations\nconst BAD_OLD = 1;\nconst BAD_BOUNDARY = 2;\nconst BAD_NEW = 3;\n",
  );
  fixture.commit("2021-01-01T00:00:01Z");

  expect(fixture.lint()).toMatchObject({ status: 1, names: ["BAD_NEW"] });
});

test("checks unstaged and staged edits even when the cutoff is in the future", () => {
  using fixture = createFixture();
  fixture.write("const BAD_OLD = 1;\nconst BAD_EDITED = 2;\n");
  fixture.commit("2020-01-01T00:00:00Z");
  fixture.write("const BAD_OLD = 1;\nconst BAD_EDITED = 3;\nconst BAD_ADDED = 4;\n");
  writeFileSync(
    fixture.plugin,
    readFileSync(fixture.plugin, "utf8").replace("2021-01-01", "2999-01-01"),
  );

  expect(fixture.lint()).toMatchObject({ status: 1, names: ["BAD_EDITED", "BAD_ADDED"] });
  fixture.git(["add", "input.ts"]);
  expect(fixture.lint()).toMatchObject({ status: 1, names: ["BAD_EDITED", "BAD_ADDED"] });
});

test("checks files without committed history and files outside Git", () => {
  using fixture = createFixture();
  fixture.write("const BAD_UNTRACKED = 1;\n");
  expect(fixture.lint()).toMatchObject({ status: 1, names: ["BAD_UNTRACKED"] });
  fixture.git(["add", "input.ts"]);
  expect(fixture.lint()).toMatchObject({ status: 1, names: ["BAD_UNTRACKED"] });
  fixture.git(["reset"]);
  fixture.git(["add", "plugin.ts"]);
  fixture.git(["commit", "--quiet", "-m", "Plugin only"]);
  expect(fixture.lint()).toMatchObject({ status: 1, names: ["BAD_UNTRACKED"] });
  fixture.git(["add", "input.ts"]);
  expect(fixture.lint()).toMatchObject({ status: 1, names: ["BAD_UNTRACKED"] });
  rmSync(join(fixture.root, ".git"), { recursive: true });
  expect(fixture.lint()).toMatchObject({ status: 1, names: ["BAD_UNTRACKED"] });
});

test("uses explicit report locations before node locations, including location-only reports", () => {
  using fixture = createFixture();
  fixture.write("const BAD_OLD = 1;\n");
  fixture.commit("2020-01-01T00:00:00Z");
  fixture.write("const BAD_OLD = 1;\nconst BAD_NEW = 2;\n");
  fixture.commit("2022-01-01T00:00:00Z");
  const plugin = readFileSync(fixture.plugin, "utf8");
  writeFileSync(
    fixture.plugin,
    plugin.replace("{ node, messageId:", "{ node, loc: { line: 1, column: 0 }, messageId:"),
  );
  expect(fixture.lint()).toMatchObject({ status: 0, names: [] });
  writeFileSync(
    fixture.plugin,
    plugin.replace(
      "{ node, messageId:",
      "{ loc: { start: { line: 2, column: 0 }, end: { line: 2, column: 5 } }, messageId:",
    ),
  );
  expect(fixture.lint()).toMatchObject({ status: 1, names: ["BAD_OLD", "BAD_NEW"] });
});

test("keeps rule metadata and fixes, fixing only new violations", () => {
  using fixture = createFixture();
  fixture.write("const BAD_OLD = 1;\n");
  fixture.commit("2020-01-01T00:00:00Z");
  fixture.write("const BAD_OLD = 1;\nconst BAD_NEW = 2;\n");
  expect(fixture.lint("--fix")).toMatchObject({ status: 0, names: [] });
  expect(readFileSync(fixture.file, "utf8")).toBe("const BAD_OLD = 1;\nconst goodNEW = 2;\n");
});

test("checks shallow boundary lines whose true author date is unavailable", () => {
  using fixture = createFixture();
  fixture.write("const BAD_OLD = 1;\n");
  fixture.commit("2020-01-01T00:00:00Z");
  fixture.write("const BAD_OLD = 1;\n// second commit\n");
  fixture.commit("2020-06-01T00:00:00Z");
  fixture.git([
    "clone",
    "--quiet",
    "--depth=1",
    "file://" + fixture.root,
    join(fixture.root, "shallow"),
  ]);
  expect(fixture.lint()).toMatchObject({ status: 0, names: [] });
  expect(fixture.lint("shallow/input.ts")).toMatchObject({ status: 1, names: ["BAD_OLD"] });
});

test("resolves history in linked worktrees", () => {
  using fixture = createFixture();
  fixture.write("const BAD_OLD = 1;\n");
  fixture.commit("2020-01-01T00:00:00Z");
  fixture.git(["worktree", "add", "--detach", join(fixture.root, "linked"), "HEAD"]);
  expect(fixture.lint("linked/input.ts")).toMatchObject({ status: 0, names: [] });
});

test("surfaces Git failures instead of silently exempting violations", () => {
  using fixture = createFixture();
  fixture.write("const BAD_OLD = 1;\n");
  fixture.commit("2020-01-01T00:00:00Z");
  fixture.git(["config", "blame.ignoreRevsFile", "missing-ignore-revs"]);
  expect(fixture.lint()).toMatchObject({
    status: 1,
    output: expect.stringContaining("missing-ignore-revs"),
  });
});

test("handles renamed paths containing Git pathspec characters", () => {
  using fixture = createFixture();
  fixture.write("const BAD_OLD = 1;\n");
  fixture.commit("2020-01-01T00:00:00Z");
  fixture.git(["mv", "input.ts", "input[1].ts"]);
  fixture.git(["commit", "--quiet", "-m", "Rename file"]);
  expect(fixture.lint("input[1].ts")).toMatchObject({ status: 0, names: [] });
});

test("PR mode checks changed lines regardless of dates and trusts untouched lines", () => {
  using fixture = createFixture();
  fixture.write("const BAD_BASE = 1;\nconst BAD_EDIT = 2;\n");
  fixture.commit("2022-01-01T00:00:00Z");
  const base = fixture.git(["rev-parse", "HEAD"]);
  fixture.write(
    "// shift old lines\nconst BAD_BASE = 1;\nconst BAD_EDIT = 3;\nconst BAD_PR = 4;\n",
  );
  fixture.commit("2020-01-01T00:00:00Z");

  // The edited lines predate the cutoff; the untouched line is newer than it.
  expect(fixture.lint()).toMatchObject({ status: 1, names: ["BAD_BASE"] });
  fixture.env.ITERATE_LINT_PR_BASE = base;
  expect(fixture.lint()).toMatchObject({ status: 1, names: ["BAD_EDIT", "BAD_PR"] });
});

test("PR mode works with shallow history and no usable blame", () => {
  using fixture = createFixture();
  fixture.write("const BAD_BASE = 1;\n");
  fixture.commit("2022-01-01T00:00:00Z");
  const base = fixture.git(["rev-parse", "HEAD"]);
  fixture.write("const BAD_BASE = 1;\nconst BAD_NEW = 2;\n");
  fixture.commit("2020-01-01T00:00:00Z");
  const shallow = join(fixture.root, "shallow");
  fixture.git(["clone", "--quiet", "--depth=1", "file://" + fixture.root, shallow]);
  fixture.git(["-C", shallow, "fetch", "--quiet", "--depth=1", "origin", base]);
  fixture.git(["-C", shallow, "config", "blame.ignoreRevsFile", "missing"]);
  expect(fixture.git(["-C", shallow, "rev-parse", "--is-shallow-repository"])).toBe("true");
  fixture.env.ITERATE_LINT_PR_BASE = base;
  expect(fixture.lint("shallow/input.ts")).toMatchObject({
    status: 1,
    names: ["BAD_NEW", "BAD_NEW"],
  });
});

test("PR autofix recomputes changed lines after a fix inserts a line", () => {
  using fixture = createFixture();
  fixture.write("const BAD_BASE = 1;\n");
  fixture.commit("2022-01-01T00:00:00Z");
  fixture.env.ITERATE_LINT_PR_BASE = fixture.git(["rev-parse", "HEAD"]);
  fixture.write("const BAD_NEW = 2;\nconst BAD_BASE = 1;\n");
  writeFileSync(
    fixture.plugin,
    readFileSync(fixture.plugin, "utf8").replace(
      '"good" + node.name.slice(4)',
      '"good" + node.name.slice(4) + "\\n"',
    ),
  );
  expect(fixture.lint("--fix")).toMatchObject({ status: 0, names: [] });
  expect(readFileSync(fixture.file, "utf8")).toBe("const goodNEW\n = 2;\nconst BAD_BASE = 1;\n");
});

test("PR mode follows a rename and checks only edits in the renamed file", () => {
  using fixture = createFixture();
  fixture.write(
    "const BAD_BASE = 1;\n// padding for rename detection\n// more unchanged content\n",
  );
  fixture.commit("2022-01-01T00:00:00Z");
  fixture.env.ITERATE_LINT_PR_BASE = fixture.git(["rev-parse", "HEAD"]);
  mkdirSync(join(fixture.root, "nested folder"));
  fixture.git(["mv", "input.ts", "nested folder/renamed.ts"]);
  writeFileSync(
    join(fixture.root, "nested folder/renamed.ts"),
    "const BAD_BASE = 1;\n// padding for rename detection\n// more unchanged content\nconst BAD_NEW = 2;\n",
  );
  fixture.git(["add", "nested folder/renamed.ts"]);
  fixture.git(["commit", "--quiet", "-m", "Rename and edit"]);
  expect(fixture.lint("nested folder/renamed.ts")).toMatchObject({ status: 1, names: ["BAD_NEW"] });
});

test("PR mode checks new files and fails for unavailable comparison history", () => {
  using fixture = createFixture();
  fixture.git(["add", "plugin.ts"]);
  fixture.git(["commit", "--quiet", "-m", "Initial"]);
  fixture.env.ITERATE_LINT_PR_BASE = fixture.git(["rev-parse", "HEAD"]);
  fixture.write("const BAD_NEW = 1;\n");
  expect(fixture.lint()).toMatchObject({ status: 1, names: ["BAD_NEW"] });
  fixture.env.ITERATE_LINT_PR_BASE = "a".repeat(40);
  expect(fixture.lint()).toMatchObject({
    status: 1,
    output: expect.stringContaining("not a tree object"),
  });
});

test("rejects invalid cutoff dates", () => {
  expect(() => grandfatherRule({ allowedUpTo: new Date("invalid"), create: () => ({}) })).toThrow(
    "valid allowedUpTo date",
  );
});

const repoRoot = resolve(import.meta.dirname, "..");

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "grandfather-rule-"));
  const file = join(root, "input.ts");
  writeFileSync(
    join(root, "plugin.ts"),
    `
    import { grandfatherRule } from ${JSON.stringify(join(repoRoot, "lint/grandfather-rule.ts"))};
    export default {
      meta: { name: "fixture" },
      rules: { old: grandfatherRule({
        allowedUpTo: new Date("2021-01-01"),
        meta: { type: "suggestion", fixable: "code", messages: { banned: "Found {{name}}" } },
        create(context) {
          return { Identifier(node) {
            if (!node.name.startsWith("BAD_")) return;
            context.report({ node, messageId: "banned", data: { name: node.name },
              fix(fixer) { return fixer.replaceText(node, "good" + node.name.slice(4)); }
            });
          } };
        }
      }) }
    };
  `,
  );
  writeFileSync(
    join(root, ".oxlintrc.json"),
    JSON.stringify({
      categories: { correctness: "off" },
      jsPlugins: [join(root, "plugin.ts")],
      rules: { "fixture/old": "error" },
    }),
  );
  function git(args: string[], env: Record<string, string> = {}) {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return result.stdout.trim();
  }
  git(["init", "--quiet"]);
  git(["config", "user.name", "Lint Test"]);
  git(["config", "user.email", "lint@test.invalid"]);
  const env = { ...process.env, ITERATE_LINT_PR_BASE: "" };
  return {
    env,
    root,
    file,
    plugin: join(root, "plugin.ts"),
    git,
    write(contents: string) {
      writeFileSync(file, contents);
    },
    commit(date: string) {
      git(["add", "input.ts"]);
      git(["commit", "--quiet", "-m", "Change source"], {
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z",
      });
    },
    lint(...args: string[]) {
      const result = spawnSync(
        join(repoRoot, "node_modules/.bin/oxlint"),
        ["input.ts", "--config", join(root, ".oxlintrc.json"), "--threads", "1", ...args],
        { cwd: root, encoding: "utf8", env },
      );
      const output = result.stdout + result.stderr;
      return {
        status: result.status,
        names: [...output.matchAll(/Found (BAD_\w+)/g)].map((match) => match[1]),
        output,
      };
    },
    [Symbol.dispose]() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
