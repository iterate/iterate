// Providing a secret from the phone, without leaving the app.
//
// An agent drops a `/collect-secret/...` link into a thread. On the phone the
// app does not open it — it renders the request natively and writes the secret
// over the itx session it already holds. So this spec is the proof that the
// whole round trip works with no browser in it: real link, real chat message,
// native sheet, and a real secret at the end.
//
// The link is built by the OS-side builder that mints it in production
// (apps/os/src/lib/collect-secret-link.ts), which is what keeps the app's
// parser honest about that encoding.
//
// The message carrying the link is appended over admin itx; the app's own
// "I submitted the secret" messages open turns that the fixture's scripted
// model answers.

import { expect } from "@playwright/test";
import { buildCollectSecretUrl } from "../../apps/os/src/lib/collect-secret-link.ts";
import { test } from "../test-support/test.ts";

const SECRET_PATH = "/secrets/integrations/stripe/api-key";

test("provides a secret from the thread, with no browser in the way", async ({ page, helpers }) => {
  await using fixture = await helpers.createMobileFixture("mobile-collect-secret");
  const { itx } = fixture;

  const agent = await fixture.createAgent();
  agent.responses.set(async () => "ok");
  await page.goto(agent.mobileUrl);

  // The message an agent sends when it needs a credential it must never see.
  const link = buildCollectSecretUrl({
    baseUrl: fixture.baseUrl,
    projectSlug: fixture.projectSlug,
    search: {
      egress: ["https://api.stripe.com"],
      path: SECRET_PATH,
      description: "Stripe restricted key — Developers → API keys",
      // What collectFromUser sets when an agent scope mints the link: the
      // agent to tell once the secret is stored.
      notify: agent.path,
    },
  });
  // web-message-sent is the agent's reply into the thread — the same event a
  // real turn emits, so the link arrives exactly as a user would meet it.
  await agent.append({
    type: "events.iterate.com/agents/web-message-sent",
    payload: { message: `I need your Stripe key. [Provide it here](${link})` },
  });

  // Tapping the link opens the request in the app, not a browser. (The
  // markdown renderer draws links as styled text with its own press handler,
  // not as anchors, so this is a text tap.)
  await page.getByText("Provide it here").click();
  await page.getByText("Stripe restricted key — Developers → API keys").waitFor();
  await page.getByText(SECRET_PATH).waitFor();
  await page.getByText("https://api.stripe.com").waitFor();

  // Pasting a credential on a phone is blind — the eye toggle is how you check
  // you pasted the key and not the clipboard's previous occupant.
  const value = page.getByLabel("Value", { exact: true });
  await value.fill("sk_test_notarealkey");
  expect(await value.getAttribute("type")).toBe("password");
  await page.getByLabel("Show value").click();
  expect(await value.getAttribute("type")).not.toBe("password");

  await page.getByLabel("Save secret").click();

  // Saving returns you straight to the thread, where the agent has been told —
  // as a message from you, the same one the web page sends. That message
  // arriving IS the confirmation, so it is what the spec waits for.
  // timeout: the spinner-waiter cannot see a wait that spans a screen pop.
  await expect
    .poll(() => page.getByText(`I submitted the secret at "${SECRET_PATH}"`).count(), {
      timeout: 30_000,
    })
    .toBe(1);
  await page.getByText("I need your Stripe key.").waitFor();

  // Stored write-only and already pinned — checked at the source rather than
  // taken from the app's own copy.
  const secret = await itx.secrets.get(SECRET_PATH).__describe();
  expect(secret).toMatchObject({ hasMaterial: true, egress: { urls: ["https://api.stripe.com"] } });

  // ── Rotation. The same link over an existing secret must REPLACE the
  // material, and say so first. This is the failure the create/update choice
  // guards: create() over an existing secret with the same policy is a no-op
  // that keeps the old value, and the stored-material check cannot tell the
  // difference — the screen and the agent would both report a rotation that
  // never happened.
  await page.getByText("Provide it here").click();
  await page.getByText("This replaces an existing secret").waitFor();
  await page.getByLabel("Value", { exact: true }).fill("sk_test_rotated");
  await page.getByLabel("Save secret").click();
  // Back in the thread again, now with two of those messages.
  // timeout: the spinner-waiter cannot see a wait that spans a screen pop.
  await expect
    .poll(() => page.getByText(`I submitted the secret at "${SECRET_PATH}"`).count(), {
      timeout: 30_000,
    })
    .toBe(2);

  // Material is write-only, so "did it actually change?" is answered by the
  // secret's own stream: a rotation appends secret/updated, a no-op create
  // appends nothing.
  using secretStream = itx.streams.get(SECRET_PATH);
  const events = await secretStream.getEvents({});
  expect(events.map((event) => event.type)).toContain("events.iterate.com/secret/updated");
});
