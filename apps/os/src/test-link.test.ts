// test-link.test.ts — a preview's one-click sign-in link (test-link.ts) as a table of what the
// redeeming deployment decides: the round trip, then every way a link is refused — tampered, another
// preview's, expired, an address outside the domain, a `next` or client off the linked origins — and
// 404 wherever `login.testLink` is off. That app-config.ts refuses the block off a workers.dev or
// localhost `urls.os` is its own row; the route at the edge is worker.test.ts's.

import { expect, test } from "vitest";
import { parseAppConfig } from "./app-config.ts";
import { mintTestLink, redeemTestLink } from "./test-link.ts";

const pr123 = "https://pr123-feature-os-preview.iterate-dev-preview.workers.dev";
const pr124 = "https://pr124-other-os-preview.iterate-dev-preview.workers.dev";
const dash123 = "https://pr123-feature-dash-preview.iterate-dev-preview.workers.dev";
const now = Date.UTC(2026, 8, 24);
const link = {
  key: "preview-secrets-key",
  audience: pr123,
  email: "pr123@preview.iterate.test",
  next: `${dash123}/projects/pr123`,
  clients: [dash123],
  expiresAt: now + 14 * 24 * 3600_000,
};

test("a link minted for this preview signs its person in and sends them to its next", async () => {
  expect(await redeemTestLink(await mintTestLink(link), at(pr123))).toEqual({
    status: 302,
    email: "pr123@preview.iterate.test",
    project: "pr123",
    next: `${dash123}/projects/pr123`,
    clients: [dash123],
  });
});

test("a tampered payload — another person under the same signature — is refused", async () => {
  const [payload, signature] = (await mintTestLink(link)).split(".");
  const claims = JSON.parse(atob(payload!.replaceAll("-", "+").replaceAll("_", "/")));
  const forged = btoa(JSON.stringify({ ...claims, email: "jonas@preview.iterate.test" }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  expect(await redeemTestLink(`${forged}.${signature}`, at(pr123))).toMatchObject({
    status: 403,
    message: "This sign-in link's signature is not valid here.",
  });
});

test.each([
  ["no token", async () => null, /malformed/],
  [
    "a flipped byte",
    async () => {
      const token = await mintTestLink(link);
      return `${token.slice(0, -2)}${token.at(-2) === "A" ? "B" : "A"}${token.at(-1)}`;
    },
    /signature/,
  ],
  [
    "another deployment's key",
    () => mintTestLink({ ...link, key: "prd-secrets-key" }),
    /signature/,
  ],
  ["not base64url", async () => "a+b.c/d", /signature/],
])("%s is refused", async (_, token, message) => {
  expect(await redeemTestLink(await token(), at(pr123))).toMatchObject({
    status: 403,
    message: expect.stringMatching(message),
  });
});

test("another preview's link is refused: every preview shares the key, not the audience", async () => {
  expect(await redeemTestLink(await mintTestLink(link), at(pr124))).toEqual({
    status: 403,
    message: `This sign-in link is for ${pr123}, not this deployment.`,
  });
});

test("an expired link is refused", async () => {
  const expired = await mintTestLink({ ...link, expiresAt: now - 1 });
  expect(await redeemTestLink(expired, at(pr123))).toMatchObject({
    status: 403,
    message: expect.stringMatching(/expired/),
  });
});

test.each([
  ["an address outside the domain", { email: "jonas@iterate.com" }, /outside preview.iterate.test/],
  ["a next off the linked origins", { next: "https://evil.example/" }, /does not send people/],
  ["a next over http to a workers.dev host", { next: "http://x.workers.dev/" }, /send people/],
  ["a client off the linked origins", { clients: ["https://evil.example"] }, /client/],
])("%s is refused", async (_, change, message) => {
  expect(await redeemTestLink(await mintTestLink({ ...link, ...change }), at(pr123))).toMatchObject(
    {
      status: 403,
      message: expect.stringMatching(message),
    },
  );
});

test("the platform origin itself and a local origin are linked origins", async () => {
  for (const next of [`${pr123}/login`, "http://localhost:5173/projects/pr123"])
    expect(await redeemTestLink(await mintTestLink({ ...link, next }), at(pr123))).toMatchObject({
      status: 302,
      next,
    });
});

test("with `login.testLink` off the route does not exist, whatever the link", async () => {
  expect(
    await redeemTestLink(await mintTestLink(link), { ...at(pr123), testLink: undefined }),
  ).toEqual({ status: 404, message: "Not found" });
});

const base = { APP_CONFIG_SECRETS__KEY: "k", APP_CONFIG_LOGIN__PASSWORD: "p" };

test("login.testLink: prd's own domain refuses it, even from a mistaken Doppler value", () => {
  expect(() =>
    parseAppConfig({
      ...base,
      APP_CONFIG_URLS__OS: "https://os.iterate.com",
      APP_CONFIG_LOGIN__TEST_LINK__EMAIL_DOMAIN: "preview.iterate.test",
    }),
  ).toThrow(/APP_CONFIG login\.testLink .*only for a preview or local dev/);
  // a blank urls.os (a self-host on each request's own origin) must name one first
  expect(() =>
    parseAppConfig({ ...base, APP_CONFIG: JSON.stringify({ login: { testLink: {} } }) }),
  ).toThrow(/only for a preview or local dev/);
});

test("login.testLink: a preview's workers.dev origin and localhost accept it; absent is off", () => {
  for (const os of [pr123, "http://localhost:8788"])
    expect(
      parseAppConfig({
        ...base,
        APP_CONFIG_URLS__OS: os,
        APP_CONFIG_LOGIN__TEST_LINK__EMAIL_DOMAIN: "preview.iterate.test",
      }),
    ).toMatchObject({ login: { testLink: { emailDomain: "preview.iterate.test" } } });
  expect(parseAppConfig({ ...base, APP_CONFIG_URLS__OS: pr123 })).not.toHaveProperty(
    "login.testLink",
  );
});

/** The deployment redeeming a link: a preview at `platformOrigin`, with links on and the key. */
function at(platformOrigin: string) {
  return {
    testLink: { emailDomain: "preview.iterate.test" },
    key: "preview-secrets-key",
    platformOrigin,
    now,
  };
}
