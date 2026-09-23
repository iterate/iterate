// Start client navigation is exercised in Chromium. The phone project covers the issuer pages'
// server-rendered flows; it does not wait for client hydration.
import { expect } from "@playwright/test";
import { test } from "./test.ts";

test("client navigation loads sign-in through its server function and rejects malformed payloads", async ({
  page,
  baseURL,
}) => {
  await page.goto(baseURL!);
  // Until React hydrates the link it is a plain anchor, and a click loads the page in full.
  const signInLink = page.getByRole("link", { name: "sign-in" });
  await expect
    .poll(() =>
      signInLink.evaluate((link) =>
        Object.keys(link).some((key) => key.startsWith("__reactProps")),
      ),
    )
    .toBe(true);
  const serverFunction = page.waitForResponse((response) =>
    new URL(response.url()).pathname.startsWith("/_serverFn/"),
  );
  await signInLink.click();
  const response = await serverFunction;
  expect(response.status()).toBe(200);
  await page.getByRole("heading", { name: "Sign in to iterate" }).waitFor();
  await expect(page.locator('input[name="next"]')).toHaveValue("/login");

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
  for (const payload of ["{bad", "1", "{}", "null", '"x"', frozen, rejectedPromise]) {
    const malformed = new URL(response.url());
    malformed.searchParams.set("payload", payload);
    expect((await page.request.get(malformed.href)).status(), payload).toBe(400);
  }

  const noPayload = new URL(response.url());
  noPayload.search = "";
  const empty = await page.request.get(noPayload.href, {
    headers: { "x-tsr-serverFn": "true" },
  });
  expect(empty.status()).toBe(200);
  expect(await empty.text()).not.toContain("$TSR/Error");
});
