// Tests for iterate/icon-button-has-hover-text: icon-size <Button>s render no
// visible text, so they must carry an aria-label (or title) — the design
// system's Button turns the aria-label into a title attribute, giving hover
// text for free. The popular off-the-shelf rule for this
// (jsx-a11y/control-has-associated-label) deliberately assumes any
// uppercase-component child (like a lucide icon) might render a text label,
// so it never flags `<Button size="icon"><Trash /></Button>` — hence this
// custom rule.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

import { test } from "vitest";

test("flags an icon-size Button with no label", () => {
  using fixture = createOxlintFixture();
  fixture.write(
    "unlabeled.tsx",
    [
      "declare const Button: any, Trash: any;",
      "export const remove = (",
      '  <Button size="icon-sm" variant="outline">',
      "    <Trash />",
      "  </Button>",
      ");",
      "",
    ].join("\n"),
  );

  const result = fixture.runOxlint(["unlabeled.tsx"], { expectFailure: true });
  assert.match(result.stdout + result.stderr, /Add aria-label/);
});

test("flags all icon sizes, including in render props", () => {
  using fixture = createOxlintFixture();
  fixture.write(
    "render-prop.tsx",
    [
      "declare const Button: any, DialogClose: any, X: any;",
      "export const close = (",
      '  <DialogClose render={<Button size="icon-xs" />}>',
      "    <X />",
      "  </DialogClose>",
      ");",
      "",
    ].join("\n"),
  );

  fixture.runOxlint(["render-prop.tsx"], { expectFailure: true });
});

test("accepts aria-label, title, dynamic labels, spreads, and non-icon sizes", () => {
  using fixture = createOxlintFixture();
  fixture.write(
    "labeled.tsx",
    [
      "declare const Button: any, Trash: any, Plus: any, props: any, label: string;",
      "export const ok = (",
      "  <>",
      '    <Button size="icon-sm" aria-label="Delete row">',
      "      <Trash />",
      "    </Button>",
      '    <Button size="icon" title="Delete row">',
      "      <Trash />",
      "    </Button>",
      '    <Button size="icon-lg" aria-label={label}>',
      "      <Trash />",
      "    </Button>",
      '    <Button size="icon-sm" {...props}>',
      "      <Trash />",
      "    </Button>",
      '    <Button size="sm">',
      "      <Plus />",
      "      Connect",
      "    </Button>",
      "  </>",
      ");",
      "",
    ].join("\n"),
  );

  fixture.runOxlint(["labeled.tsx"]);
});

test("rejects an empty aria-label", () => {
  using fixture = createOxlintFixture();
  fixture.write(
    "empty-label.tsx",
    [
      "declare const Button: any, Trash: any;",
      "export const remove = (",
      '  <Button size="icon-sm" aria-label=" ">',
      "    <Trash />",
      "  </Button>",
      ");",
      "",
    ].join("\n"),
  );

  fixture.runOxlint(["empty-label.tsx"], { expectFailure: true });
});

const repoRoot = resolve(import.meta.dirname, "..");
const pluginPath = join(repoRoot, "lint", "oxlint-plugin-iterate.ts");
const oxlintBin = join(repoRoot, "node_modules", ".bin", "oxlint");

/** Same fixture shape as oxlint-plugin-itx-script.test.ts: a temp project
 * with the real plugin armed, linted by the real oxlint binary. */
function createOxlintFixture() {
  const root = mkdtempSync(join(tmpdir(), "iterate-oxlint-icon-button-"));
  const configPath = join(root, ".oxlintrc.json");

  writeFileSync(
    configPath,
    JSON.stringify(
      {
        categories: {
          correctness: "off",
          nursery: "off",
          pedantic: "off",
          perf: "off",
          restriction: "off",
          style: "off",
          suspicious: "off",
        },
        env: {
          builtin: true,
          node: true,
        },
        jsPlugins: [pluginPath],
        rules: { "iterate/icon-button-has-hover-text": "error" },
      },
      null,
      2,
    ),
  );

  return {
    root,
    [Symbol.dispose]() {
      rmSync(root, { force: true, recursive: true });
    },
    runOxlint(args: string[], options: { expectFailure?: boolean } = {}) {
      const result = spawnSync(
        oxlintBin,
        [...args, "--config", configPath, "--threads", "1", "--format", "stylish"],
        { cwd: root, encoding: "utf8" },
      );
      if (options.expectFailure) {
        assert.notEqual(result.status, 0, result.stderr || result.stdout);
      } else {
        assert.equal(result.status, 0, result.stderr || result.stdout);
      }
      return result;
    },
    write(path: string, contents: string) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    },
  };
}
