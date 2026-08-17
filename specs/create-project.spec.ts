import { expect } from "@playwright/test";
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
test("the config template creates and opens onboarding for a new project", async ({
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

  // The config worker receives project/created, creates the onboarding agent,
  // and redirects the connected OS client. The composer is structural route
  // chrome, so this does not wait for an LLM response. Manual timeout: the
  // cold creation saga and redirect can outlast spinner-waiter's ceiling.
  await page.getByPlaceholder("Message this agent").waitFor({ timeout: 60_000 }); // timeout: cold creation and redirect can outlast spinner-waiter's ceiling
  expect(new URL(page.url())).toMatchObject({
    pathname: `/projects/${firstSlug}/agents/streams/agents/onboarding`,
  });
  using admin = await connectAdminItx(baseURL);
  using firstProject = admin.projects.get(firstSlug);
  // Manual timeout: this ITX event poll has no browser loading UI for
  // spinner-waiter to observe.
  await expect
    .poll(
      async () => {
        const event = await firstProject.agents.get("/agents/onboarding").stream.getEvent({
          idempotencyKey: "iterate/config/onboarding-instructions:v1",
        });
        return event?.payload?.content;
      },
      { timeout: 60_000, intervals: [500] }, // timeout: ITX polling has no browser UI for spinner-waiter
    )
    .toContain("# Onboarding Agent");

  const slug = uniqueFixtureSlug("create-project");
  // /new-project is the deep-linked create sheet (sidebar + projects list
  // both link here). Navigate directly so strict-mode locators don't have
  // to disambiguate multiple "Create project" controls.
  await page.goto("/new-project");

  await page.getByLabel("Slug").fill(slug);
  // Create resolves after the atomic birth batch, then the userspace config
  // worker handles project/created and drives this connected OS tab to its
  // onboarding agent. Manual timeout: cold build + saga + redirect can
  // outlast spinner-waiter's ceiling.
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByPlaceholder("Message this agent").waitFor({ timeout: 90_000 }); // timeout: cold build and userspace redirect can outlast spinner-waiter's ceiling
  expect(new URL(page.url())).toMatchObject({
    pathname: `/projects/${slug}/agents/streams/agents/onboarding`,
  });

  using createdProject = admin.projects.get(slug);
  const onboardingAgent = createdProject.agents.get("/agents/onboarding");
  const [createdEvent, promptEvent] = await Promise.all([
    onboardingAgent.stream.getEvents({ eventTypes: ["events.iterate.com/agent/created"] }),
    onboardingAgent.stream.getEvent({
      idempotencyKey: "iterate/config/onboarding-instructions:v1",
    }),
  ]);
  expect(
    createdEvent.find((event) => event.type === "events.iterate.com/agent/created")?.payload,
  ).toEqual({});
  expect(promptEvent?.payload?.content).toContain("# Onboarding Agent");
});
