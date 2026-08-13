import { statSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { addPlugins } from "middlewright";
import { screenshot } from "./screenshot.ts";

test("saves a successful locator screenshot under its readable locator slug", async ({
  page,
}, testInfo) => {
  using _environment = environmentVariable("PLAYWRIGHT_SCREENSHOT", ".*");
  await using plugged = await addPlugins({ page, testInfo, plugins: [screenshot()] });
  await plugged.setContent(`<a href="#dashboard">dynamic-project-slug</a>`);

  await plugged.getByRole("link", { name: "dynamic-project-slug" }).waitFor();
  await plugged.getByRole("link", { name: "dynamic-project-slug" }).waitFor();

  expect(testInfo.attachments).toMatchObject([
    {
      contentType: "image/png",
      name: "getbyrole-link-name-dynamic-project-slug",
      path: expect.any(String),
    },
    {
      contentType: "image/png",
      name: "getbyrole-link-name-dynamic-project-slug-2",
      path: expect.any(String),
    },
  ]);
  expect(
    statSync(testInfo.outputPath("getbyrole-link-name-dynamic-project-slug.png")).size,
  ).toBeGreaterThan(0);
  expect(
    statSync(testInfo.outputPath("getbyrole-link-name-dynamic-project-slug-2.png")).size,
  ).toBeGreaterThan(0);
});

test("does not overwrite a screenshot from another page in the same test", async ({
  context,
  page,
}, testInfo) => {
  using _environment = environmentVariable("PLAYWRIGHT_SCREENSHOT", ".*");
  await using firstPage = await addPlugins({ page, testInfo, plugins: [screenshot()] });
  await using secondPage = await addPlugins({
    page: await context.newPage(),
    testInfo,
    plugins: [screenshot()],
  });
  await firstPage.setContent(`<button>Save</button>`);
  await secondPage.setContent(`<button>Save</button>`);

  await firstPage.getByRole("button", { name: "Save" }).waitFor();
  await secondPage.getByRole("button", { name: "Save" }).waitFor();

  expect(testInfo.attachments).toMatchObject([
    { name: "getbyrole-button-name-save" },
    { name: "getbyrole-button-name-save-2" },
  ]);
});

const environmentVariable = (name: string, value: string) => {
  const previous = process.env[name];
  process.env[name] = value;
  return {
    [Symbol.dispose]: () => {
      if (typeof previous === "string") process.env[name] = previous;
      else delete process.env[name];
    },
  };
};
