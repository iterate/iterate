import { expect } from "@playwright/test";
import { test } from "./test-support/test.ts";

// The codemode-tag template end to end: a project seeded from
// configs/codemode-tag (pinned to this deployment's own SHA), whose hosted
// interpreter facet derives every assistant turn — the prose outside the tag
// becomes the chat bubble, the tag body becomes a script run whose result
// drives the next turn, and the raw response (tags included) never renders
// in the feed.
//
// Local-dev caveat: with no APP_CONFIG_ITERATE_REPO_PKG_REF the template
// reference stays unpinned and seeds from the repo's default branch — so
// until the template changes merge, run this one against a preview.
test("codemode-tag turns render as derived prose bubbles and script activity, never raw tags", async ({
  helpers,
  page,
}) => {
  await using fixture = await helpers.createFixture("codemode-render", {
    configRepoTemplate: "codemode-tag",
  });

  const agent = await fixture.createAgent();
  agent.responses.setOnce(async () => {
    return [
      "Sure — computing now.",
      "",
      '<codemode status="Multiplying numbers">',
      "return 21 * 2",
      "</codemode>",
    ].join("\n");
  });
  // The script's rendered result (a developer context item) drives this
  // second turn; prose alone ends it.
  agent.responses.setOnce(async () => "The answer is 42. Anything else?");

  // The template converts newborn agents asynchronously (parsing off +
  // codemode prompt + interpreter subscription). createAgent lowers the
  // birth debounce that would otherwise hold the first turn open for that
  // conversion, so wait for it explicitly before talking — a turn taken
  // before conversion is platform-parsed and never derived. Manual timeout:
  // ITX polling has no browser UI for spinner-waiter.
  await expect
    .poll(
      async () => {
        const snapshot = await (agent as any).processor.snapshot();
        return snapshot.state.config;
      },
      { intervals: [500], timeout: 60_000 }, // timeout: ITX polling has no browser loading UI for spinner-waiter
    )
    .toMatchObject({ interpretResponses: false });

  await page.goto(agent.webUrl);
  const composer = page.getByPlaceholder("Message this agent");
  await composer.fill("What is 21 times 2?");
  await page.getByRole("button", { name: "Send message" }).click();

  // The prose outside the tag is THE assistant message. Manual timeout: the
  // interpreter facet cold-builds (npm install + bundle) on its first wake,
  // and spinner-waiter cannot see that server-side work.
  await page.getByText("Sure — computing now.").waitFor({ timeout: 120_000 }); // timeout: the facet cold build is server-side work with no loading UI for spinner-waiter
  // The extracted script ran (activity row summarizes the code step) and its
  // return value fed the follow-up turn.
  await page.getByText("The answer is 42. Anything else?").waitFor({ timeout: 120_000 }); // timeout: script run + second round trip behind the same cold facet, invisible to spinner-waiter

  // The raw model output's tag syntax was superseded by the derived views
  // and never renders anywhere in the feed. (The script BODY legitimately
  // shows inside an expanded activity card — only the tag is format noise.)
  // waitFor(hidden) resolves immediately when no such text exists — the
  // locator-shaped negative assertion.
  await page.getByText("<codemode").waitFor({ state: "hidden" });
});
