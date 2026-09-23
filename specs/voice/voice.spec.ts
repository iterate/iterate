import { expect } from "@playwright/test";
import { test } from "../test-support/test.ts";

test("a new project installs its voice agent from the page, then has a Call button", async ({
  page,
  baseURL,
  helpers,
}) => {
  // Locally, no Voice app is a skip; in CI it is a failure (the preview's e2e job always has one).
  test.skip(
    !process.env.CI && !process.env.VOICE_BASE_URL,
    "The Voice specs need the Voice app deployed against the platform under test",
  );
  expect(process.env.VOICE_BASE_URL, "VOICE_BASE_URL: the preview's Voice app").toBeTruthy();
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
