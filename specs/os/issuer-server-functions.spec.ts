// Start client navigation is exercised in Chromium. The phone project covers the issuer pages'
// server-rendered flows; it does not wait for client hydration.
import { expect } from "@playwright/test";
import { spinnerWaiter } from "middlewright";
import { test } from "../test-support/test.ts";

test("client navigation loads sign-in through its server function and rejects malformed payloads", async ({
  page,
}) => {
  await page.goto("/");
  // Until React hydrates the link it is a plain anchor, and a click loads the page in full.
  // Exact: the landing page also links the Dash, whose preview host carries the branch name.
  const signInLink = page.getByRole("link", { name: "sign-in", exact: true });
  await expect
    .poll(() => signInLink.evaluate((link) => Object.keys(link)))
    .toContainEqual(expect.stringMatching(/^__reactProps/));
  const serverFunction = page.waitForResponse((response) =>
    new URL(response.url()).pathname.startsWith("/_serverFn/"),
  );
  await signInLink.click();
  const response = await serverFunction;
  expect(response.status()).toBe(200);
  await page.getByRole("heading", { name: "Sign in to iterate" }).waitFor();
  // A hidden input is never visible, and the spinner-waiter judges readiness by visibility:
  // Playwright's own wait for it to attach is the right one here.
  const next = await spinnerWaiter.settings.run({ disabled: true }, () =>
    page.locator('input[name="next"]').inputValue(),
  );
  expect(next).toBe("/login");

  const withNext = new URL(response.url());
  const serialized = JSON.parse(withNext.searchParams.get("payload")!);
  serialized.t.p.v[0].p = { k: ["next"], v: [{ t: 1, s: "/welcome" }] };
  withNext.searchParams.set("payload", JSON.stringify(serialized));
  const requested = await page.request.get(withNext.href, {
    headers: { "x-tsr-serverFn": "true" },
  });
  expect(requested.status()).toBe(200);
  expect(await requested.text()).toContain("/welcome");

  const frozen = JSON.stringify({
    t: {
      t: 10,
      i: 0,
      p: { k: ["data"], v: [{ t: 10, i: 1, p: { k: [], v: [] }, o: 3 }] },
      o: 0,
    },
    f: 63,
    m: [],
  });
  const rejectedPromise = JSON.stringify({
    t: {
      t: 10,
      i: 0,
      p: {
        k: ["data"],
        v: [
          {
            t: 10,
            i: 1,
            p: { k: ["next"], v: [{ t: 12, i: 2, s: 0, f: { t: 1, s: "boom" } }] },
            o: 0,
          },
        ],
      },
      o: 0,
    },
    f: 63,
    m: [],
  });
  for (const payload of ["{bad", "1", "{}", "null", '"x"', rejectedPromise]) {
    const malformed = new URL(response.url());
    malformed.searchParams.set("payload", payload);
    expect((await page.request.get(malformed.href)).status(), payload).toBe(400);
  }
  // a frozen object is still plain data (apps/os/src/start.ts); the input validator reads it as no search
  const withFrozen = new URL(response.url());
  withFrozen.searchParams.set("payload", frozen);
  const frozenRequested = await page.request.get(withFrozen.href, {
    headers: { "x-tsr-serverFn": "true" },
  });
  expect(frozenRequested.status()).toBe(200);
  expect(await frozenRequested.text()).not.toContain("$TSR/Error");

  const noPayload = new URL(response.url());
  noPayload.search = "";
  const empty = await page.request.get(noPayload.href, {
    headers: { "x-tsr-serverFn": "true" },
  });
  expect(empty.status()).toBe(200);
  expect(await empty.text()).not.toContain("$TSR/Error");
});
