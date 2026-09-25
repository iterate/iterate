// A per-PR preview's one-click sign-in (apps/os/src/test-link.ts): the PR body's `Sign in ↗` is a
// link signed with the deployment's key. On local dev, opening it in a browser that has never
// signed in lands signed in, no email typed and no password — inside the Dash's project, with no
// Allow page between (consent.ts approves the sibling app the link names). On a preview the PR
// body is public, so a link alone signs nobody in: it sends the browser to prd to prove it is an
// admin's, asking only who they are (apps/os/src/test-link-admins.ts) — what the spec checks there,
// since no spec holds an admin's prd session. Runs against the local worker (local dev turns the
// links on; its key is apps/os/scripts/generate-wrangler-config.ts's) or, with DEMO_BASE_URL, a
// preview under `doppler run` (its key is the Previews' `APP_CONFIG_SECRETS__KEY`). A deployment
// on its own domain has the links off: nothing to prove there, so the specs skip.
import { expect } from "@playwright/test";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import { mintTestLink, TEST_LINK_PATH } from "../../apps/os/src/test-link.ts";
import { openOperatorSession } from "../test-support/operator.ts";
import { test } from "../test-support/test.ts";

test("a sign-in link signs a fresh browser in as its test person, on a preview only once prd says it is an admin's; a link with a flipped byte is refused", async ({
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
  if (isPreview(origin)) {
    // the link is good, and still signs nobody in: it asks prd who the browser is, for the
    // userinfo resource alone, as this preview's own CIMD client
    const response = await page.request.get(`${TEST_LINK_PATH}?t=${token}`, { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    const authorize = new URL(response.headers().location!);
    expect({
      at: `${authorize.origin}${authorize.pathname}`,
      clientId: authorize.searchParams.get("client_id"),
      resource: authorize.searchParams.getAll("resource"),
    }).toEqual({
      at: `${PRD_ISSUER}/oauth2/auth`,
      clientId: `${origin}${TEST_LINK_PATH}/client.json`,
      resource: [`${PRD_ISSUER}/oauth2/userinfo`],
    });
    // nobody is signed in: the only cookie is the check's own
    expect(
      response
        .headersArray()
        .filter(({ name }) => name.toLowerCase() === "set-cookie")
        .map(({ value }) => value.split("=")[0]),
    ).toEqual(["__Host-iterate-test-link"]);
    return;
  }
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
  test.skip(isPreview(origin), "on a preview, redeeming a link needs an admin's prd sign-in");
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

/** Where every preview's admins prove who they are (apps/os/scripts/preview-config.ts). */
const PRD_ISSUER = "https://os.iterate.com";

/** A preview, whose links need an admin (app-config.ts requires `login.testLink.admins` off
 *  localhost) — not local dev. */
const isPreview = (origin: string) => new URL(origin).hostname.endsWith(".workers.dev");
