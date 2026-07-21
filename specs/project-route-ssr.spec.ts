import { expect } from "@playwright/test";
import { test } from "./test-support/test.ts";

test("server-renders project routes before the itx client connects", async ({ helpers, page }) => {
  await using fixture = await helpers.createFixture("project-route-ssr");
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));

  const response = await page.goto(`/projects/${fixture.project.slug}/agents/new`);
  if (response === null) throw new Error("Direct project navigation returned no document response");

  const initialHtml = await response.text();
  expect(initialHtml).toContain('placeholder="Message a new agent"');
  expect(initialHtml).toContain("New agent");

  await page.getByRole("textbox", { name: "Message a new agent" }).fill("Hello from SSR");

  const replResponse = await page.goto(`/projects/${fixture.project.slug}/repl`);
  if (replResponse === null) throw new Error("Direct project REPL navigation returned no response");
  expect(await replResponse.text()).toContain("Connecting to itx...");
  await page.getByText("Run TypeScript against your Iterate context.").waitFor();

  expect(pageErrors).toEqual([]);
});
