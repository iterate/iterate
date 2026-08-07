import { expect } from "@playwright/test";
import { spinnerWaiter } from "middlewright";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import {
  signUpWithEmailOtp,
  startEmailOtpSignIn,
  uniqueSignupEmail,
} from "./test-support/email-otp-signup.ts";
import { connectAdminItx } from "./test-support/forged-session.ts";
import { test } from "./test-support/test.ts";

// Deviation from the suite's forged-session fixture pattern: this spec uses a
// freshly signed-up user, not a forged session. Creating a project mints new
// auth claims, and only a real session can refresh its access token to pick
// up the new project claim the post-create navigation authorizes with.
test("config templates create and open their own onboarding agents", async ({
  baseURL,
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  if (!baseURL) throw new Error("Playwright baseURL fixture is required.");
  test.skip(
    !(await startEmailOtpSignIn(page, testInfo)),
    "Email OTP sign-in is disabled for this deployment (APP_CONFIG_EMAIL_OTP_ENABLED on auth / APP_CONFIG_ITERATE_AUTH__EMAIL_OTP_ENABLED on OS).",
  );
  const firstSlug = uniqueFixtureSlug("first-project");
  await signUpWithEmailOtp(page, {
    email: uniqueSignupEmail("create-project"),
    projectSlug: firstSlug,
    testInfo,
  });

  await page
    .getByTestId("project-dashboard")
    .or(page.getByPlaceholder("Message this agent"))
    .waitFor({ timeout: 60_000 });
  using admin = await connectAdminItx(baseURL);
  using firstProject = admin.projects.get(firstSlug);
  await expect
    .poll(
      async () => {
        const events = await firstProject.agents.get("/agents/onboarding").stream.getEvents({});
        return events.find(
          (event) =>
            event.type === "events.iterate.com/agents/context-added" &&
            event.payload?.key === "agent/system-prompt",
        )?.payload?.content;
      },
      { timeout: 60_000, intervals: [500] },
    )
    .toContain("# Onboarding Agent");

  const slug = uniqueFixtureSlug("create-project");
  // Preview orchestration exposes the exact PR head so this project seeds the
  // template under test; main keeps the spec usable after merge and locally.
  const templateRef = process.env.TEST_TELEMETRY_HEAD_SHA?.trim() || "main";
  // spinner-waiter is disabled through here: the /projects pending state and
  // the project page's loading state can render two spinner-matching elements
  // at once, tripping its strict-mode isVisible.
  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    // /new-project is the deep-linked create sheet (sidebar + projects list
    // both link here). Navigate directly so strict-mode locators don't have
    // to disambiguate multiple "Create project" controls.
    await page.goto("/new-project");

    await page.getByLabel("Slug").fill(slug, { timeout: 15_000 });
    await page
      .getByLabel("Config template (optional)")
      .fill(`github:iterate/iterate#${templateRef}&path:configs/with-voice`);
    // Create resolves after the atomic birth batch, then project home shows
    // the bootstrap saga. The userspace voice template handles project/created,
    // creates its onboarding agent, and drives this connected OS tab to it.
    await page.getByRole("button", { name: "Create project" }).click({ timeout: 15_000 });
    await page.getByPlaceholder("Message this agent").waitFor({ timeout: 90_000 });
  });
  expect(new URL(page.url())).toMatchObject({
    pathname: `/projects/${slug}/agents/streams/agents/onboarding`,
  });

  using voiceProject = admin.projects.get(slug);
  const voiceEvents = await voiceProject.agents.get("/agents/onboarding").stream.getEvents({});
  expect(
    voiceEvents.find((event) => event.type === "events.iterate.com/agent/created")?.payload,
  ).toEqual({ purpose: "onboarding", template: "with-voice" });
  expect(
    voiceEvents.find(
      (event) =>
        event.type === "events.iterate.com/agents/context-added" &&
        event.payload?.key === "agent/system-prompt",
    )?.payload?.content,
  ).toContain("# Voice Project Onboarding");
});
