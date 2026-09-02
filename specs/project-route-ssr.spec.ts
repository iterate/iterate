import { expect } from "@playwright/test";
import { test } from "./test-support/test.ts";

test("project home hydrates the dashboard and REPL still server-renders", async ({
  helpers,
  page,
}) => {
  await using fixture = await helpers.createFixture("project-route-ssr");
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));

  // Project home is client-only (`ssr: false`) — the new-agent dashboard
  // hydrates after load rather than embedding the composer in the initial HTML.
  await page.goto(`/projects/${fixture.project.slug}`);
  await page.getByTestId("project-dashboard").waitFor();
  const composer = page.getByRole("combobox", { name: "Message a new agent" });
  await composer.fill("@onb");
  await page.getByRole("option", { name: "ONBOARDING.md" }).click();
  expect(await composer.inputValue()).toBe("@ONBOARDING.md ");
  await composer.fill("Hello from dashboard");

  // The legacy new-agent URL is a router redirect (server-side 3xx on a
  // direct hit) to the project home.
  await page.goto(`/projects/${fixture.project.slug}/agents/new`);
  await page.getByTestId("project-dashboard").waitFor();
  expect(new URL(page.url())).toMatchObject({ pathname: `/projects/${fixture.project.slug}` });

  const replResponse = await page.goto(`/projects/${fixture.project.slug}/repl`);
  if (replResponse === null) throw new Error("Direct project REPL navigation returned no response");
  expect(await replResponse.text()).toContain("Connecting to itx...");
  await page.getByText("Run TypeScript as real project scripts.").waitFor();

  expect(pageErrors).toEqual([]);
});
