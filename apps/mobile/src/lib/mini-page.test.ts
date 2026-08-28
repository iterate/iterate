import { expect, test } from "vitest";
import { openMiniPage, readMiniPageReturn, resolveMiniPageUrl } from "./mini-page.ts";

const context = { baseUrl: "https://os.iterate.com" };

test("secret-collection links open as a mini page", () => {
  expect(
    resolveMiniPageUrl(
      'https://os.iterate.com/collect-secret/acme?path=/secrets/stripe&egress=["https://api.stripe.com"]',
      context,
    ),
  ).toBe(
    'https://os.iterate.com/collect-secret/acme?path=/secrets/stripe&egress=["https://api.stripe.com"]',
  );
});

test("everything else stays with the system browser", () => {
  // A lookalike host must never render inside our sheet, where it would look
  // like part of the app.
  expect(resolveMiniPageUrl("https://evil.example/collect-secret/acme", context)).toBeNull();
  expect(resolveMiniPageUrl("http://os.iterate.com/collect-secret/acme", context)).toBeNull();
  // "/collect-secrets" must not match "/collect-secret".
  expect(resolveMiniPageUrl("https://os.iterate.com/collect-secretly", context)).toBeNull();
  expect(resolveMiniPageUrl("https://os.iterate.com/projects/acme", context)).toBeNull();
  expect(resolveMiniPageUrl("not a url", context)).toBeNull();
  expect(
    resolveMiniPageUrl("https://os.iterate.com/collect-secret/acme", { baseUrl: undefined }),
  ).toBeNull();
});

test("opening a mini page hands it the deep link it closes on, and reads the outcome back", async () => {
  const opened: { returnUrl: string; url: string }[] = [];
  const outcome = await openMiniPage({
    openAuthSession: async (url, returnUrl) => {
      opened.push({ returnUrl, url });
      // What the OS page navigates to when the secret is stored — the
      // navigation the browser sheet dismisses itself on.
      return { type: "success", url: `${returnUrl}?path=/secrets/stripe&status=notified` };
    },
    returnUrl: "iterate://mini-page",
    url: "https://os.iterate.com/collect-secret/acme?path=/secrets/stripe",
  });

  expect(opened).toEqual([
    {
      returnUrl: "iterate://mini-page",
      url: "https://os.iterate.com/collect-secret/acme?path=%2Fsecrets%2Fstripe&returnTo=iterate%3A%2F%2Fmini-page",
    },
  ]);
  expect(outcome).toMatchObject({
    kind: "done",
    params: { path: "/secrets/stripe", status: "notified" },
    status: "notified",
  });
});

test("swiping the sheet away is not an outcome", async () => {
  const outcome = await openMiniPage({
    openAuthSession: async () => ({ type: "cancel" }),
    returnUrl: "iterate://mini-page",
    url: "https://os.iterate.com/collect-secret/acme?path=/secrets/stripe",
  });
  expect(outcome).toEqual({ kind: "dismissed" });
});

test("a mini page that returns without a status still counts as finished", () => {
  expect(readMiniPageReturn("iterate://mini-page")).toEqual({
    kind: "done",
    params: {},
    status: undefined,
  });
});
