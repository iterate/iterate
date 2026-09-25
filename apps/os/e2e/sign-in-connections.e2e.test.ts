// sign-in-connections.e2e.test.ts — signing in with Google, Cloudflare and GitHub on a deployed
// worker, through the deployed pet shop's fakes (a preview's iterate clients, scripts/preview-*-app.ts):
// each sign-in keeps its token as the person's own connection. Google's is then lent to the person's
// project, used there through egress, refreshed at the lender after a forced expiry, and refused once
// the lend is revoked. Deployed only: the fakes' redirects come back to a public origin.
import { expect } from "vitest";
import { TEST_LINK_EMAIL_DOMAIN } from "../src/test-link.ts";
import { cookieSession, workerUrl } from "./support/client.ts";
import { petshopBaseUrl, petshopExpireTokens } from "./support/petshop.ts";
import { deployedOnly, freshDnsSafeProjectSlug } from "./support/project-host.ts";

deployedOnly(
  "Sign in with Google keeps its token: the person's own connection, lent to their project, used there through egress, refreshed at the lender, refused once revoked",
  async ({ skip }) => {
    const email = `${freshDnsSafeProjectSlug("google")}@${TEST_LINK_EMAIL_DOMAIN}`;
    const cookie = await signInThroughFake("/.auth/identity", { email });
    if (!cookie) return skip("this deployment's Google client is not the pet shop's fake");
    const api: any = await cookieSession(cookie);
    const [connection] = Object.values(
      (await api.user.facets.get("account").snapshot()).state.integrations,
    ) as { provider: string; connection: string; account: string }[];
    expect(connection).toMatchObject({ provider: "google", account: email });
    const path = `/secrets/google-${connection!.connection}`;
    expect(await api.user.secrets.list()).toContainEqual(
      expect.objectContaining({ path, refresh: "oauth-refresh-token" }),
    );
    const itx = await api.projects.create({ project: freshDnsSafeProjectSlug("lend") });
    const { projectId } = await itx.whoami();
    const { lendId } = await api.user.secrets.lend(path, {
      to: projectId,
      as: "/secrets/google-me",
    });
    expect(await gmailProfile(itx)).toMatchObject({ status: 200, body: { emailAddress: email } });
    // every outstanding token of the fake's client answers 401 now: the lender's secret refreshes
    await petshopExpireTokens("petshop-default");
    expect(await gmailProfile(itx)).toMatchObject({ status: 200, body: { emailAddress: email } });
    await api.user.secrets.revokeLend(path, lendId);
    expect(await gmailProfile(itx)).toMatchObject({ status: 502 });
  },
);

deployedOnly(
  "Sign in with Cloudflare and with GitHub each keep a connection the person's own egress uses",
  async ({ skip }) => {
    for (const [path, choices, api] of [
      [
        "/.auth/identity/cloudflare",
        { email: `${freshDnsSafeProjectSlug("cf")}@${TEST_LINK_EMAIL_DOMAIN}` },
        `${petshopBaseUrl()}/client/v4/user`,
      ],
      [
        "/.auth/identity/github",
        {
          login: freshDnsSafeProjectSlug("gh"),
          email: `${freshDnsSafeProjectSlug("gh")}@${TEST_LINK_EMAIL_DOMAIN}`,
        },
        `${petshopBaseUrl()}/user`,
      ],
    ] as const) {
      const cookie = await signInThroughFake(path, choices);
      if (!cookie) return skip(`this deployment's ${path} client is not the pet shop's fake`);
      const session: any = await cookieSession(cookie);
      const [connection] = Object.values(
        (await session.user.facets.get("account").snapshot()).state.integrations,
      ) as { provider: string; connection: string }[];
      const used: Response = await session.user.fetch(
        new Request(api, {
          headers: {
            authorization: `Bearer getSecret("/secrets/${connection!.provider}-${connection!.connection}", { field: "accessToken" })`,
            "user-agent": "iterate",
          },
        }),
      );
      expect(used, `${path}: ${await used.clone().text()}`).toMatchObject({ status: 200 });
    }
  },
);

/** A browser signing in at `path` through a pet-shop fake — `choices` are the person's picks at its
 *  page — following the platform's redirects back for consent: the session cookie, or null when the
 *  provider is not the pet shop. */
async function signInThroughFake(
  path: string,
  choices: Record<string, string>,
): Promise<string | null> {
  let response = await fetch(`${workerUrl(path)}?next=%2F`, { redirect: "manual" });
  for (let hop = 0; hop < 3 && response.status === 302; hop++) {
    const cookie = response.headers.getSetCookie()[0]!.split(";")[0]!;
    const authorization = new URL(response.headers.get("location")!);
    if (authorization.origin !== petshopBaseUrl()) return null;
    for (const [key, value] of Object.entries(choices)) authorization.searchParams.set(key, value);
    const consent = await fetch(authorization, { redirect: "manual" });
    expect(consent, await consent.clone().text()).toMatchObject({ status: 302 });
    response = await fetch(consent.headers.get("location")!, {
      headers: { cookie },
      redirect: "manual",
    });
  }
  expect(response, await response.clone().text()).toMatchObject({ status: 303 });
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0]!)
    .find((value) => value.startsWith("__Host-itx-session="))!;
}

async function gmailProfile(itx: any) {
  const response: Response = await itx.fetch(
    new Request(`${petshopBaseUrl()}/gmail/v1/users/me/profile`, {
      headers: {
        authorization: `Bearer getSecret("/secrets/google-me", { field: "accessToken" })`,
      },
    }),
  );
  const text = await response.text();
  return { status: response.status, body: response.ok ? JSON.parse(text) : text };
}
