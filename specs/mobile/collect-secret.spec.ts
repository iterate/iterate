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
// ZERO model turns: the message carrying the link is appended over admin itx.

import { expect } from "@playwright/test";
import { connectItxReady } from "iterate/node";
import { buildCollectSecretUrl } from "../../apps/os/src/lib/collect-secret-link.ts";
import { localOsDevServer } from "../../apps/os/scripts/dev.ts";
import { signUpWithEmailOtp, uniqueSignupEmail } from "../test-support/email-otp-signup.ts";
import { resolveAdminSecret } from "../test-support/forged-session.ts";
import { test } from "../test-support/test.ts";

const SECRET_PATH = "/secrets/integrations/stripe/api-key";

test("provides a secret from the thread, with no browser in the way", async ({
  page,
}, testInfo) => {
  const osBaseUrl = await resolveOsBaseUrl();
  const projectSlug = `mobile-collect-secret-${Date.now().toString(36)}`;

  await signUpToProject(page, testInfo, osBaseUrl, projectSlug);
  const projectId = new URL(page.url()).pathname.split("/")[2]!;

  await page.getByText("New chat").click();
  const pathHeading = page.getByRole("heading", { name: /^mobile\// });
  await pathHeading.waitFor();
  const agentPath = `/agents/${await pathHeading.textContent()}`;

  using itx = await connectItxReady({
    auth: { type: "admin-secret", secret: await resolveAdminSecret() },
    baseUrl: osBaseUrl,
    projectId,
  });
  using agent = itx.agents.get(agentPath);
  await agent.create();
  // The message an agent sends when it needs a credential it must never see.
  const link = buildCollectSecretUrl({
    baseUrl: osBaseUrl,
    projectSlug,
    search: {
      egress: ["https://api.stripe.com"],
      path: SECRET_PATH,
      description: "Stripe restricted key — Developers → API keys",
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
  // The Save button does swap to a spinner for the whole write — this is not a
  // screen missing loading UI. Measured: a deliberately 6s-long save was still
  // given only the base budget, so the spinner-waiter is not crediting it, and
  // a preview save (several real round trips) cannot fit in that.
  // timeout: spinner-waiter does not credit this screen's Save spinner.
  await page.getByText("Secret saved").waitFor({ timeout: 30_000 });

  // Stored write-only and already pinned — checked at the source rather than
  // taken from the sheet's own success copy.
  const secret = await itx.secrets.get(SECRET_PATH).__describe();
  expect(secret).toMatchObject({ hasMaterial: true, egress: { urls: ["https://api.stripe.com"] } });

  await page.getByLabel("Back to chat").click();
  await page.getByText("I need your Stripe key.").waitFor();

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
  // timeout: spinner-waiter does not credit this screen's Save spinner, as above.
  await page.getByText("Secret saved").waitFor({ timeout: 30_000 });

  // Material is write-only, so "did it actually change?" is answered by the
  // secret's own stream: a rotation appends secret/updated, a no-op create
  // appends nothing.
  using secretStream = itx.streams.get(SECRET_PATH);
  const events = await secretStream.getEvents({});
  expect(events.map((event) => event.type)).toContain("events.iterate.com/secret/updated");
});

async function signUpToProject(
  page: test.Page,
  testInfo: test.TestInfo,
  osBaseUrl: string,
  projectSlug: string,
): Promise<void> {
  await page.goto("/");
  await page.getByPlaceholder("https://os.iterate.com").fill(osBaseUrl);
  // timeout: OIDC discovery + client registration have no loading UI for the spinner waiter
  const popupPromise = page.waitForEvent("popup", { timeout: 15_000 });
  await page.getByRole("button", { name: "Sign in" }).click();
  const popup = await popupPromise;
  await popup.getByTestId("email-login-button").click();
  await signUpWithEmailOtp(popup, {
    email: uniqueSignupEmail("mobile-collect-secret"),
    projectSlug,
    testInfo,
  });
  // Project selection auto-continues for test identities (project-access.tsx)
  // — consent is the next interactive page.
  await popup.getByRole("button", { name: "Allow access" }).click();
  await page.getByText("New chat").waitFor();
  // Video-mode demos start at the interesting part, not the OAuth ceremony.
  page.videoMode?.setStartTime();
}

async function resolveOsBaseUrl(): Promise<string> {
  const configured = process.env.APP_CONFIG_BASE_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  const target = await localOsDevServer.resolveTarget();
  return target.baseUrl;
}
