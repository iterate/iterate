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

const environmentVariable = (name: string, value: string) => {
  const previous = process.env[name];
  process.env[name] = value;
  return {
    [Symbol.dispose]: () => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    },
  };
};
