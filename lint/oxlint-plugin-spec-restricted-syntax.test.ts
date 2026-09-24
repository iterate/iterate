// Tests for iterate/spec-restricted-syntax: the Playwright spec house style (specs/AGENTS.md).
// Locators wait through loading UI, so an awaited `expect` on UI state is refused; so are
// assertions that fail unhelpfully (toBe(true/false)), waitForURL, and baseURL spelled into goto.
// Each case runs the real oxlint binary against a temp project with the plugin armed.

import { expect, test } from "vitest";
import { createOxlintFixture } from "./oxlint-fixture.ts";

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
  using fixture = createOxlintFixture({ rules: { "iterate/spec-restricted-syntax": "error" } });
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

  const messages = fixture
    .diagnostics(["example.spec.ts"])
    .filter((diagnostic) => diagnostic.code === "iterate(spec-restricted-syntax)")
    .sort((a, b) => a.labels[0]!.span.offset - b.labels[0]!.span.offset)
    .map((diagnostic) => diagnostic.message);
  expect(messages).toEqual(reported.map((opening) => expect.stringContaining(opening)));
});
