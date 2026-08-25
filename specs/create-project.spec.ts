import { expect } from "@playwright/test";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import { spinnerWaiter } from "middlewright";
import {
  signUpWithEmailOtp,
  startEmailOtpSignIn,
  uniqueSignupEmail,
} from "./test-support/email-otp-signup.ts";
import { connectAdminItx } from "./test-support/forged-session.ts";
import { test } from "./test-support/test.ts";

const assistantMessage = '[data-testid="agent-feed-message"][data-kind="assistant"]';
const userMessage = '[data-testid="agent-feed-message"][data-kind="user"]';

// Deviation from the suite's forged-session fixture pattern: this spec uses a
// freshly signed-up user, not a forged session. Creating a project mints new
// auth claims, and only a real session can refresh its access token to pick
// up the new project claim the post-create navigation authorizes with.
test("the config template opens a proactive onboarding conversation for a new project", async ({
  baseURL,
  page,
}, testInfo) => {
  // Two LLM turns plus two project-creation sagas and their UI transitions.
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
        // Found by payload key, not idempotency key: the template repo may
        // come from a pinned ref whose worker code predates the current
        // event shape, and the key survives both.
        const events = await firstProject.agents.get("/agents/onboarding").stream.getEvents({
          eventTypes: ["events.iterate.com/agents/context-added"],
        });
        return events.find((event) => event.payload?.key === "config/onboarding-instructions")
          ?.payload?.content;
      },
      { timeout: 60_000, intervals: [500] }, // timeout: ITX polling has no browser UI for spinner-waiter
    )
    .toContain("# Onboarding Agent");

  const slug = uniqueFixtureSlug("create-project");
  // /new-project is the deep-linked create sheet (sidebar + projects list
  // both link here). Navigate directly so strict-mode locators don't have
  // to disambiguate multiple "Create project" controls.
  await page.goto("/new-project");

  await page.getByLabel("Project template").click();
  await page.getByRole("option", { name: "Default" }).waitFor();
  await page.getByRole("option", { name: "Codemode tag" }).waitFor();
  await page.getByRole("option", { name: "With voice" }).click();
  await page.getByLabel("Slug").fill(slug);
  // Create resolves after the atomic birth batch. The selected voice template
  // then handles project/created in userspace and drives this connected OS tab
  // to its own onboarding agent. Manual timeout: cold build + saga + redirect
  // can outlast spinner-waiter's ceiling.
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByPlaceholder("Message this agent").waitFor({ timeout: 90_000 }); // timeout: cold build and userspace redirect can outlast spinner-waiter's ceiling
  expect(new URL(page.url())).toMatchObject({
    pathname: `/projects/${slug}/agents/streams/agents/onboarding`,
  });

  using createdProject = admin.projects.get(slug);
  const onboardingAgent = createdProject.agents.get("/agents/onboarding");

  // The userspace prompt starts the agent without waiting for the user. Route
  // chrome can render before Thinking starts, leaving a push-only gap with no
  // spinner, so use an explicit bound for the unsolicited first turn.
  const assistantMessages = page.locator(assistantMessage);
  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    await assistantMessages.first().waitFor({ timeout: 120_000 }); // timeout: manual because the proactive turn can begin before spinner-waiter sees Thinking
    await page.getByRole("button", { name: "Send message" }).waitFor({ timeout: 120_000 }); // timeout: manual because spinner-waiter is disabled for the proactive turn
  });
  const assistantMessagesBeforeReply = await assistantMessages.count();

  const answer = "I want it to welcome visitors and collect a short spoken response.";
  await page.getByPlaceholder("Message this agent").fill(answer);
  await page.getByRole("button", { name: "Send message" }).click();
  await page.locator(userMessage).getByText(answer).waitFor();

  // The second settled assistant row proves the onboarding agent received the
  // user's answer and continued the conversation in the same browser feed.
  // This onboarding turn may commit stable project facts before replying, so
  // it can legitimately outlast spinner-waiter's generic 30-second ceiling.
  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    await assistantMessages.nth(assistantMessagesBeforeReply).waitFor({ timeout: 120_000 }); // timeout: manual because spinner-waiter is disabled for the multi-tool onboarding turn
    await page.getByRole("button", { name: "Send message" }).waitFor({ timeout: 120_000 }); // timeout: manual because spinner-waiter is disabled for the multi-tool onboarding turn
  });

  const [projectCreatedEvents, createdEvent, contextEvents] = await Promise.all([
    createdProject.streams
      .get("/")
      .getEvents({ eventTypes: ["events.iterate.com/project/created"] }),
    onboardingAgent.stream.getEvents({ eventTypes: ["events.iterate.com/agent/created"] }),
    onboardingAgent.stream.getEvents({
      eventTypes: ["events.iterate.com/agents/context-added"],
    }),
  ]);
  // Found by payload key for the same pinned-ref tolerance as the poll above.
  const promptEvent = contextEvents.find(
    (event) => event.payload?.key === "config/onboarding-instructions",
  );
  expect(
    createdEvent.find((event) => event.type === "events.iterate.com/agent/created")?.payload,
  ).toEqual({});
  expect(
    projectCreatedEvents.find((event) => event.type === "events.iterate.com/project/created")
      ?.payload?.config?.configRepoTemplate,
  ).toMatch(/^github:iterate\/iterate#(?:[0-9a-f]{40}&)?path:configs\/with-voice$/);
  expect(promptEvent?.payload?.content).toContain("# Voice Project Onboarding");
});
