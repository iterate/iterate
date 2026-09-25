// A per-PR preview's one-click sign-in (apps/os/src/test-link.ts): the PR body's `Sign in ↗` is a
// link signed with the deployment's key, and opening it in a browser that has never signed in lands
// signed in, no email typed and no password — inside the Dash's project, with no Allow page between
// (consent.ts approves the sibling app the link names). Runs against the local worker (local dev
// turns the links on; its key is apps/os/scripts/generate-wrangler-config.ts's) or, with
// DEMO_BASE_URL, a per-commit deployment under `doppler run --config preview` (its key is that
// config's `APP_CONFIG_SECRETS__KEY`).
// A deployment on its own domain has the links off: nothing to prove there, so the specs skip.
import { expect } from "@playwright/test";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import { mintTestLink, TEST_LINK_PATH } from "../../apps/os/src/test-link.ts";
import { openOperatorSession } from "../test-support/operator.ts";
import { test } from "../test-support/test.ts";

test("a preview's sign-in link signs a fresh browser in as its test person; a link with a flipped byte is refused", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const key = testLinkKeyOf(origin);
  const email = "pr0@preview.iterate.test";
  const token = await mintTestLink({
    key,
    audience: origin,
    email,
    next: `${origin}/login`,
    clients: [],
    expiresAt: Date.now() + 10 * 60_000,
  });
  // one character of the signature changed: the MAC no longer matches, and nobody is signed in
  const flipped = `${token.slice(0, -2)}${token.at(-2) === "A" ? "B" : "A"}${token.at(-1)}`;
  const refused = await page.goto(`${TEST_LINK_PATH}?t=${flipped}`);
  expect(refused?.status()).toBe(403);
  await page.getByText("This sign-in link's signature is not valid here.").waitFor();
  await page.goto(`${TEST_LINK_PATH}?t=${token}`);
  await page.getByText(`Signed in as ${email}.`).waitFor();
});

test("the Dash's sign-in link lands inside the test person's project: one click, no Allow page", async ({
  page,
  baseURL,
  helpers,
}) => {
  const origin = new URL(baseURL!).origin;
  const key = testLinkKeyOf(origin);
  const dash = helpers.appOrigin("dash");
  // CI's seed (apps/os/scripts/preview.ts `previewSignIn`), for a fresh person: `<slug>@…` owning
  // the project `<slug>` — the email's local part is the project the link's grant is approved for
  const slug = uniqueFixtureSlug("link");
  const email = `${slug}@preview.iterate.test`;
  using operator = openOperatorSession();
  using _project = await operator.authenticate({ email }).projects.create({ project: slug });
  const token = await mintTestLink({
    key,
    audience: origin,
    email,
    next: `${dash}/projects/${slug}`,
    clients: [dash],
    expiresAt: Date.now() + 10 * 60_000,
  });
  await page.goto(`${TEST_LINK_PATH}?t=${token}`);
  // every client app's shell (packages/ui app-shell.tsx) names the active project in its switcher
  await page.getByRole("button", { name: "Switch project" }).filter({ hasText: slug }).waitFor();
  const landed = new URL(page.url());
  expect({ origin: landed.origin, pathname: landed.pathname }).toEqual({
    origin: dash,
    pathname: `/projects/${slug}`,
  });
});

/** The key links are minted with where they exist: local dev's fixed one, or a preview's from
 *  `doppler run`. Anywhere else — prd, a preview without the key in the environment — skips. */
function testLinkKeyOf(origin: string) {
  const { hostname } = new URL(origin);
  const local = hostname === "localhost";
  const key = local ? "dev-secrets-key" : process.env.APP_CONFIG_SECRETS__KEY;
  test.skip(
    !key || !(local || hostname.endsWith(".workers.dev")),
    "test links exist only on a preview or local dev, and minting one needs its key",
  );
  return key!;
}
