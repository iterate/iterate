// sign-in-connections.e2e.test.ts — signing in with Google, Cloudflare and GitHub on a deployed
// worker, through the deployed pet shop's fakes (a preview's iterate clients, scripts/preview-*-app.ts):
// each sign-in keeps its token as the person's own connection. Google's is then connected to the
// person's project in one click (`itx.integrations.connect("google", { account })`), used there
// through egress, refreshed at the person's connection after a forced expiry, and refused once
// disconnected from the project, which leaves the person's connection standing. Deployed only: the
// fakes' redirects come back to a public origin.
import { expect } from "vitest";
import { TEST_LINK_EMAIL_DOMAIN } from "../src/test-link.ts";
import { cookieSession, workerUrl } from "./support/client.ts";
import { petshopBaseUrl, petshopExpireTokens } from "./support/petshop.ts";
import { deployedOnly, freshDnsSafeProjectSlug } from "./support/project-host.ts";

deployedOnly(
  "Sign in with Google keeps its token as your account: a project connects it in one click, uses it through egress, refreshed at your connection, and disconnecting it there leaves it yours",
  async ({ skip }) => {
    const email = `${freshDnsSafeProjectSlug("google")}@${TEST_LINK_EMAIL_DOMAIN}`;
    const cookie = await signInThroughFake("/.auth/identity", { email });
    if (!cookie) return skip("this deployment's Google client is not the pet shop's fake");
    const api: any = await cookieSession(cookie);
    const yours = async () =>
      Object.values((await api.user.facets.get("account").snapshot()).state.integrations) as {
        provider: string;
        connection: string;
        account: string;
      }[];
    const [account] = await yours();
    expect(account).toMatchObject({ provider: "google", account: email });
    const path = `/secrets/google-${account!.connection}`;
    expect(await api.user.secrets.list()).toContainEqual(
      expect.objectContaining({ path, refresh: "oauth-refresh-token" }),
    );
    const itx = await api.projects.create({ project: freshDnsSafeProjectSlug("connect") });
    // the sign-in granted what the project asks for: no provider round-trip
    expect(await itx.integrations.connect("google", { account: email })).toEqual({
      connection: account!.connection,
    });
    expect(await gmailProfile(itx, path)).toMatchObject({
      status: 200,
      body: { emailAddress: email },
    });
    // every outstanding token of the fake's client answers 401 now: the person's secret refreshes
    await petshopExpireTokens("petshop-default");
    expect(await gmailProfile(itx, path)).toMatchObject({
      status: 200,
      body: { emailAddress: email },
    });
    await itx.facets
      .get("project")
      .disconnectIntegration({ provider: "google", connection: account!.connection });
    expect(await gmailProfile(itx, path)).toMatchObject({ status: 502 });
    expect(await yours()).toContainEqual(expect.objectContaining({ account: email }));
    expect(await gmailProfile(api.user, path)).toMatchObject({ status: 200 });
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

deployedOnly(
  "Sign in with GitHub as a person who never approved iterate's Email addresses permission lands on the sign-in page, told how to approve it",
  async ({ skip }) => {
    const login = freshDnsSafeProjectSlug("gh-noemail");
    const response = await callbackThroughFake("/.auth/identity/github", {
      login,
      email: `${login}@${TEST_LINK_EMAIL_DOMAIN}`,
      emails: "none",
    });
    if (!response) return skip("this deployment's GitHub client is not the pet shop's fake");
    expect(response).toMatchObject({ status: 303 });
    const location = new URL(response.headers.get("location")!, workerUrl("/"));
    expect({
      path: location.pathname,
      error: location.searchParams.get("error"),
    }).toMatchObject({
      path: "/login",
      error: expect.stringContaining("https://github.com/settings/apps/authorizations"),
    });
    expect(
      response.headers.getSetCookie().some((value) => value.startsWith("__Host-itx-session=")),
    ).toBe(false);
  },
);

/** A browser signing in at `path` through a pet-shop fake — `choices` are the person's picks at its
 *  page — following the platform's redirects back for consent: the session cookie, or null when the
 *  provider is not the pet shop. */
async function signInThroughFake(
  path: string,
  choices: Record<string, string>,
): Promise<string | null> {
  const response = await callbackThroughFake(path, choices);
  if (!response) return null;
  expect(response, await response.clone().text()).toMatchObject({ status: 303 });
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0]!)
    .find((value) => value.startsWith("__Host-itx-session="))!;
}

/** The platform's last answer to a browser signing in at `path` through a pet-shop fake, or null
 *  when the provider is not the pet shop. */
async function callbackThroughFake(
  path: string,
  choices: Record<string, string>,
): Promise<Response | null> {
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
  return response;
}

async function gmailProfile(itx: any, path: string) {
  const response: Response = await itx.fetch(
    new Request(`${petshopBaseUrl()}/gmail/v1/users/me/profile`, {
      headers: {
        authorization: `Bearer getSecret("${path}", { field: "accessToken" })`,
      },
    }),
  );
  const text = await response.text();
  return { status: response.status, body: response.ok ? JSON.parse(text) : text };
}
