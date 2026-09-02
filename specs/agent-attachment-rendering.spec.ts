import { test } from "./test-support/test.ts";

// The attachment vocabulary end to end on an ORDINARY (default-template)
// project: a user message carrying html attachment parts gets described by
// the user-message-describer facet (installed at agent birth by every
// template), and the dashboard renders the derived text — never the raw
// part syntax.
test("a user message's attachment parts derive into a clean bubble, never raw tags", async ({
  helpers,
  page,
}) => {
  await using fixture = await helpers.createFixture("attach-render");
  const agent = await fixture.createAgent();
  // No model turn needed: this spec is about USER-message derivation, so
  // keep the interceptor quiet by never triggering a request.
  agent.responses.set(async () => "ok");

  await page.goto(agent.webUrl);
  const composer = page.getByPlaceholder("Message this agent");
  await composer.waitFor();

  // The mobile composer's wire shape, appended server-side (playwright can't
  // drive the native composer): message text plus one part line per
  // attachment, filenames keying into files[] — here empty, which renders a
  // placeholder tile but exercises the whole derivation seam.
  await agent.append({
    type: "events.iterate.com/agents/context-added",
    payload: {
      role: "user",
      content: [
        "three from the trip",
        '<img alt="beach.jpg" width="1200" height="900">',
        '<img alt="cliff.jpg" width="900" height="1200">',
        '<a href="geo:51.5074,-0.1278" data-accuracy-m="15" data-captured-at="2026-09-02T00:00:00Z">Shared location</a>',
      ].join("\n"),
    },
  });

  // The described re-emission replaces the bubble: clean caption, location
  // card, and no part syntax anywhere. Manual timeouts: the describer facet
  // cold-builds on its first wake — server-side work with no loading UI for
  // spinner-waiter.
  await page.getByText("three from the trip").waitFor({ timeout: 120_000 }); // timeout: facet cold build, invisible to spinner-waiter
  await page.getByText("Shared location").waitFor({ timeout: 120_000 }); // timeout: same cold build, invisible to spinner-waiter
  await page.getByText("<img").waitFor({ state: "hidden", timeout: 120_000 }); // timeout: raw bubble is replaced once derivation lands; spinner-waiter can't see it
});
