import { test } from "../test-support/test.ts";

test("a new project installs its voice agent from the page, then has a Call button", async ({
  page,
  baseURL,
  helpers,
}) => {
  helpers.appOrigin("voice");
  // signed in to the Voice app, on the new project's page
  await using _fixture = await helpers.createFixture("voice", { app: baseURL });

  // A fresh project has no voice agent and no OpenAI key, so the page offers to install one. The
  // key is only stored: health answers without calling OpenAI.
  await page.getByLabel("OpenAI API key").fill("voice-spec-placeholder-key");
  await page.getByRole("button", { name: "Install voice", exact: true }).click();
  await page.getByRole("button", { name: "Call", exact: true }).waitFor();

  await page.reload();
  await page.getByRole("button", { name: "Call", exact: true }).waitFor();
});
