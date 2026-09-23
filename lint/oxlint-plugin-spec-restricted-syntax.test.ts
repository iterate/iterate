// Tests for iterate/spec-restricted-syntax: the Playwright spec house style (specs/AGENTS.md).
// Locators wait through loading UI, so an awaited `expect` on UI state is refused; so are
// assertions that fail unhelpfully (toBe(true/false)), waitForURL, and baseURL spelled into goto.
// Each case runs the real oxlint binary against a temp project with the plugin armed.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test.for([
  {
    name: "an awaited expect on a locator",
    source: 'await expect(page.getByTestId("status")).toHaveText("live");',
    reported: ["Use locators, not expect."],
  },
  {
    name: "an awaited negated expect",
    source: 'await expect(page.getByRole("region")).not.toContainText("other");',
    reported: ["Use locators, not expect."],
  },
  {
    name: "toBeVisible and toContainText, left to middlewright/prefer-locator-waits",
    source: [
      'await expect(page.getByText("Welcome")).toBeVisible();',
      'await expect(page.getByRole("status")).toContainText("Committed");',
    ].join("\n"),
    reported: [],
  },
  {
    name: "a plain value assertion, not awaited",
    source: 'expect(await page.getByRole("textbox").inputValue()).toBe("note");',
    reported: [],
  },
  {
    name: "expect.poll",
    source: "await expect.poll(() => requests).toEqual([{ referer: undefined }]);",
    reported: [],
  },
  {
    name: "toBe(true) and toBe(false)",
    source: ["expect(checked).toBe(true);", "expect(disabled).toBe(false);"].join("\n"),
    reported: ["Don't use toBe(true) or toBe(false)", "Don't use toBe(true) or toBe(false)"],
  },
  {
    name: "toBe with another literal",
    source: "expect(response.status()).toBe(200);",
    reported: [],
  },
  {
    name: "waitForURL",
    source: "await page.waitForURL((url) => url.pathname !== '/login');",
    reported: ["Don't use waitForURL"],
  },
  {
    name: "baseURL in goto",
    source: "await page.goto(`${baseURL}/login`);",
    reported: ["Don't use baseURL in goto"],
  },
  {
    name: "a relative goto, or another origin",
    source: ['await page.goto("/login");', "await page.goto(`${notesOrigin}/notes`);"].join("\n"),
    reported: [],
  },
])("$name", ({ source, reported }) => {
  using fixture = createOxlintFixture();
  fixture.write(
    "example.spec.ts",
    [
      "declare const expect: any, page: any, baseURL: string, notesOrigin: string;",
      "declare const requests: unknown[], checked: boolean, disabled: boolean, response: any;",
      "export async function example() {",
      source,
      "}",
      "",
    ].join("\n"),
  );

  expect(fixture.reportedMessages("example.spec.ts")).toEqual(
    reported.map((opening) => expect.stringContaining(opening)),
  );
});

const repoRoot = resolve(import.meta.dirname, "..");
const pluginPath = join(repoRoot, "lint", "oxlint-plugin-iterate.ts");
const oxlintBin = join(repoRoot, "node_modules", ".bin", "oxlint");

/** Same fixture shape as oxlint-plugin-no-shouting-constants.test.ts: a temp project with the real
 * plugin armed, linted by the real oxlint binary. */
function createOxlintFixture() {
  const root = mkdtempSync(join(tmpdir(), "iterate-oxlint-spec-restricted-syntax-"));
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
        rules: { "iterate/spec-restricted-syntax": "error" },
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
    /** The rule's messages in source order (oxlint's unix format: `file:line:col: message [rule]`). */
    reportedMessages(path: string) {
      const result = spawnSync(
        oxlintBin,
        [path, "--config", configPath, "--threads", "1", "--format", "unix"],
        { cwd: root, encoding: "utf8" },
      );
      return [
        ...result.stdout.matchAll(
          /^\S+:\d+:\d+: (.+) \[Error\/iterate\(spec-restricted-syntax\)\]$/gm,
        ),
      ].map((match) => match[1]);
    },
    write(path: string, contents: string) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    },
  };
}
