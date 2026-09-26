// __workers-tests__/integrations.test.ts — Slack, Google and GitHub connections on the worker, end to
// end against the pet shop's fakes (in memory, answering this isolate's `fetch` at slack.test,
// google.test and github.test): connect through iterate's app or the project's own, the platform's
// callback finishing it, the routes, egress with each connection's secret, and the webhooks. Every
// connection here is named `acme`.
import { createHmac } from "node:crypto";
import { env, exports } from "cloudflare:workers";
import { expect, onTestFinished, test, vi } from "vitest";
import type { StreamEvent } from "iterate/stream/processor";
import { fakeUserIdOf } from "../../dummy-petshop/src/state.ts";
import { DurableObjectNameCodec } from "../src/context/paths.ts";
import type { IntegrationScope } from "../src/integrations/connections.ts";
import { acceptGithubCallback, connectGithub } from "../src/integrations/github.ts";
import type { ProjectState } from "../src/project/contract.ts";
import type { ProjectDurableObject } from "../src/project/durable-object.ts";
import {
  catalog,
  followConsent,
  ORIGIN,
  petshopFakes,
  projectWithMember,
  readLog,
  stub,
} from "./support.ts";

const NEXT = "https://dash.test/integrations";
const SLACK_WEBHOOK = `${ORIGIN}/api/integrations/slack/webhook`;
const GITHUB_WEBHOOK = `${ORIGIN}/api/integrations/github/webhook`;
const GITHUB_CALLBACK = `${ORIGIN}/api/integrations/github/callback`;
/** iterate's Slack app's and GitHub App's webhook secrets (wrangler.test.jsonc, vitest.config.ts). */
const ITERATE_SLACK_SIGNING_SECRET = "slack-test-signing-secret";
const ITERATE_GITHUB_WEBHOOK_SECRET = "github-test-webhook-secret";

// ── Slack ──

test("Slack, iterate's app: the callback stores the token, records the workspace on / and routes it", async () => {
  const member = await projectWithMember("slack-iterate");
  const petshop = petshopFakes();
  const { authorizationUrl } = await projectFacet(member.itx).connectIntegration({
    provider: "slack",
    connection: "acme",
    client: "iterate",
    next: NEXT,
  });
  const authorize = new URL(authorizationUrl);
  expect({ at: authorize.origin, ...Object.fromEntries(authorize.searchParams) }).toMatchObject({
    at: "https://slack.test",
    client_id: "petshop-default",
    redirect_uri: `${ORIGIN}/api/integrations/slack/callback`,
  });
  const back = await followConsent(petshop, `${authorizationUrl}&team=T1ACME`, member.cookie);
  expect(back, await back.clone().text()).toMatchObject({ status: 303 });
  expect(back.headers.get("location")).toBe(NEXT);
  await vi.waitFor(async () =>
    expect(await integrationsOf(member.itx)).toMatchObject({
      "/integrations/slack/acme": {
        provider: "slack",
        client: "iterate",
        account: "Pet Shop T1ACME",
        externalId: "T1ACME",
      },
    }),
  );
  expect(await catalog().integrationRoute("slack", "T1ACME")).toEqual({
    projectId: member.projectId,
    path: "/integrations/slack/acme",
  });
});

test("Slack webhooks to iterate's app: a signed event lands once on the routed connection's log, a redelivery adding nothing", async () => {
  const member = await projectWithMember("slack-webhooks");
  await connected(petshopFakes(), member, "slack", "team=T2HOOK");
  const event = { type: "event_callback", team_id: "T2HOOK", event_id: "Ev2" };
  for (const secondsAgo of [0, 1]) {
    const delivered = await slackPost(
      SLACK_WEBHOOK,
      event,
      ITERATE_SLACK_SIGNING_SECRET,
      secondsAgo,
    );
    expect(await delivered.json()).toEqual({ ok: true });
  }
  expect(await webhooksOn(member.projectId, "/integrations/slack/acme")).toMatchObject([
    {
      type: "events.iterate.com/slack/webhook-received",
      idempotencyKey: "slack-webhook:Ev2",
      source: { platform: true },
      payload: { body: event, teamId: "T2HOOK", slackRequestTimestamp: expect.any(String) },
    },
  ]);
});

test.for([
  {
    name: "a bad signature is 401",
    body: { type: "event_callback", team_id: "T2HOOK", event_id: "Ev" },
    secret: "not-the-signing-secret",
    status: 401,
    answer: { error: "Invalid Slack signature." },
  },
  {
    name: "a team no connection holds is ignored",
    body: { type: "event_callback", team_id: "T0NOBODY", event_id: "Ev" },
    secret: ITERATE_SLACK_SIGNING_SECRET,
    status: 200,
    answer: { ok: true, ignored: "unrouted-team" },
  },
  {
    name: "url_verification answers the challenge",
    body: { type: "url_verification", challenge: "c-1" },
    secret: ITERATE_SLACK_SIGNING_SECRET,
    status: 200,
    answer: { challenge: "c-1" },
  },
])("Slack webhooks to iterate's app: $name", async ({ body, secret, status, answer }) => {
  const response = await slackPost(SLACK_WEBHOOK, body, secret);
  expect({ status: response.status, answer: await response.json() }).toEqual({ status, answer });
});

test("Slack, the project's own app: the exchange uses its client, and the secret keeps the app beside the token", async () => {
  const { member, petshop, app } = await slackOwnApp("slack-own");
  const exchange = petshop.requests.find(({ url }) => url.endsWith("/oauth.v2.access"))!;
  expect(Object.fromEntries(new URLSearchParams(exchange.body))).toMatchObject({
    client_id: app.clientId,
    client_secret: app.clientSecret,
  });
  await vi.waitFor(async () =>
    expect(await integrationsOf(member.itx)).toMatchObject({
      "/integrations/slack/acme": { client: "project", externalId: "T3OWN" },
    }),
  );
  expect(await catalog().integrationRoute("slack", "T3OWN")).toBeNull();
  const field = (name: string) => `getSecret("/secrets/slack-acme", { field: "${name}" })`;
  const posted = await member.itx.fetch(
    new Request("https://slack.test/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${field("accessToken")}`,
        "content-type": "application/json",
        "x-client-secret": field("clientSecret"),
        "x-signing-secret": field("signingSecret"),
      },
      body: JSON.stringify({ channel: "C1", text: "hello" }),
    }),
  );
  expect(await posted.json()).toMatchObject({ ok: true });
  expect((await petshop.state.getState()).slackMessages).toMatchObject({
    T3OWN: [{ channel: "C1", text: "hello" }],
  });
  expect(petshop.requests.at(-1)!.headers).toMatchObject({
    "x-client-secret": app.clientSecret,
    "x-signing-secret": "own-signing-secret",
  });
});

test.for([
  { name: "its own team's delivery lands", connection: "acme", team: "T3OWN", ignored: undefined },
  { name: "another team's is ignored", connection: "acme", team: "T0OTHER", ignored: "other-team" },
  {
    name: "one for an unknown connection is ignored",
    connection: "nobody",
    team: "T3OWN",
    ignored: "unknown-connection",
  },
])(
  "Slack, the project's own app's per-connection webhook: $name",
  async ({ connection, team, ignored }) => {
    const { member } = await slackOwnApp(`slack-own-${ignored || "lands"}`);
    const url = `${SLACK_WEBHOOK}/${member.projectId}/${connection}`;
    const event = { type: "event_callback", team_id: team, event_id: "EvOwn" };
    const answer = await (await slackPost(url, event, "own-signing-secret")).json();
    expect(answer).toEqual({ ok: true, ignored });
    expect(await webhooksOn(member.projectId, "/integrations/slack/acme")).toMatchObject(
      ignored ? [] : [{ idempotencyKey: "slack-webhook:EvOwn", payload: { teamId: "T3OWN" } }],
    );
  },
);

test("Slack: a disconnect before the human comes back fails the callback, storing no token", async () => {
  const member = await projectWithMember("slack-abandoned");
  const petshop = petshopFakes();
  const project = projectFacet(member.itx);
  const slack = { provider: "slack", connection: "acme" } as const;
  const { authorizationUrl } = await project.connectIntegration({ ...slack, client: "iterate" });
  await project.disconnectIntegration(slack);
  const back = await followConsent(petshop, `${authorizationUrl}&team=T4GONE`, member.cookie);
  expect(back).toMatchObject({ status: 400 });
  expect(await secretPathsOf(member.itx)).not.toContain("/secrets/slack-acme");
  expect(await integrationsOf(member.itx)).toEqual({});
  expect(await catalog().integrationRoute("slack", "T4GONE")).toBeNull();
});

test("Slack: a team released by one project and connected by another routes its next webhook to the new connection", async () => {
  const first = await projectWithMember("slack-release");
  const petshop = petshopFakes();
  const delivery = (id: string) =>
    slackPost(
      SLACK_WEBHOOK,
      { type: "event_callback", team_id: "T5MOVE", event_id: id },
      ITERATE_SLACK_SIGNING_SECRET,
    );
  await connected(petshop, first, "slack", "team=T5MOVE");
  await delivery("Ev5-first");
  await projectFacet(first.itx).disconnectIntegration({ provider: "slack", connection: "acme" });
  const second = await otherProject(first, "slack-reclaim");
  await connected(petshop, second, "slack", "team=T5MOVE");
  expect(await (await delivery("Ev5-second")).json()).toEqual({ ok: true });
  expect(await webhooksOn(second.projectId, "/integrations/slack/acme")).toMatchObject([
    { idempotencyKey: "slack-webhook:Ev5-second" },
  ]);
});

test("Slack: a second project cannot take a routed team, and the first keeps it", async () => {
  const first = await projectWithMember("slack-first-owner");
  const petshop = petshopFakes();
  await connected(petshop, first, "slack", "team=T6TAKEN");
  const second = await otherProject(first, "slack-second-owner");
  const back = await consented(petshop, second, "slack", "team=T6TAKEN");
  expect({ status: back.status, text: await back.text() }).toMatchObject({
    status: 400,
    text: expect.stringContaining("connected to another project"),
  });
  expect(await catalog().integrationRoute("slack", "T6TAKEN")).toEqual({
    projectId: first.projectId,
    path: "/integrations/slack/acme",
  });
});

// ── Google ──

test("Google, iterate's client: the callback records the account on /", async () => {
  const { member } = await googleConnected("google-iterate");
  await vi.waitFor(async () =>
    expect(await integrationsOf(member.itx)).toMatchObject({
      "/integrations/google/acme": {
        provider: "google",
        client: "iterate",
        account: "jonas@example.test",
        externalId: String(fakeUserIdOf("jonas@example.test")),
      },
    }),
  );
});

test("Google, iterate's client: Gmail through egress, and an expired token refreshed through iterate's client", async () => {
  const { member, petshop } = await googleConnected("google-refresh");
  expect(await gmailProfile(member.itx)).toMatchObject({ emailAddress: "jonas@example.test" });
  await petshop.state.expireAccessTokens("petshop-default");
  expect(await gmailProfile(member.itx)).toMatchObject({ emailAddress: "jonas@example.test" });
  expect(tokenGrantsOf(petshop)).toEqual([
    { grant: "authorization_code", client: "petshop-default:petshop-default-secret" },
    { grant: "refresh_token", client: "petshop-default:petshop-default-secret" },
  ]);
});

test("Google: iterate's client is refused toward any endpoint but its own Google", async () => {
  const { itx } = await projectWithMember("google-foreign");
  await expect(
    itx.secrets.beginOAuth("/secrets/x", {
      client: { platform: "google" },
      authorizationEndpoint: "https://evil.test/a",
      tokenEndpoint: "https://evil.test/t",
      urls: ["https://evil.test"],
    }),
  ).rejects.toThrow("the platform's google app is at https://google.test — not https://evil.test");
});

test("Google: disconnect revokes the grant and drops the row and the secret", async () => {
  const { member, petshop } = await googleConnected("google-disconnect");
  await vi.waitFor(async () =>
    expect(await integrationsOf(member.itx)).toHaveProperty(["/integrations/google/acme"]),
  );
  await projectFacet(member.itx).disconnectIntegration({ provider: "google", connection: "acme" });
  expect((await petshop.state.getState()).revokedRefreshTokenIds).toHaveLength(1);
  expect(await secretPathsOf(member.itx)).not.toContain("/secrets/google-acme");
  await vi.waitFor(async () => expect(await integrationsOf(member.itx)).toEqual({}));
});

test("Google, the project's own client: the refresh uses the client in the secret's own material", async () => {
  const member = await projectWithMember("google-own");
  const petshop = petshopFakes();
  const app = await petshop.state.createClient({});
  await member.itx.secrets.set("/secrets/google-acme", app, { urls: ["https://google.test"] });
  await connected(petshop, member, "google", "email=jonas@example.test", { client: "project" });
  await petshop.state.expireAccessTokens(app.clientId);
  expect(await gmailProfile(member.itx)).toMatchObject({ emailAddress: "jonas@example.test" });
  expect(tokenGrantsOf(petshop)).toEqual([
    { grant: "authorization_code", client: `${app.clientId}:${app.clientSecret}` },
    { grant: "refresh_token", client: `${app.clientId}:${app.clientSecret}` },
  ]);
});

// ── GitHub ──

test("GitHub, iterate's App: installing redirects once to the callback, which records the installation on / and routes it", async () => {
  const { member, back } = await githubInstalled("github-iterate", { installationId: "9001" });
  expect(back, await back.clone().text()).toMatchObject({ status: 303 });
  expect(back.headers.get("location")).toBe(NEXT);
  await vi.waitFor(async () =>
    expect(await integrationsOf(member.itx)).toMatchObject({
      "/integrations/github/acme": {
        provider: "github",
        client: "iterate",
        account: "org-9001",
        externalId: "9001",
      },
    }),
  );
  expect(await catalog().integrationRoute("github", "9001")).toEqual({
    projectId: member.projectId,
    path: "/integrations/github/acme",
  });
});

test("GitHub, iterate's App: a call through egress mints the installation's token", async () => {
  const { member } = await githubInstalled("github-egress", { installationId: "9002" });
  const repositories = await installationRepositories(member.itx, "/secrets/github-acme");
  expect(await repositories.json()).toMatchObject({
    repositories: [{ full_name: "org-9002/pets" }],
  });
});

test("GitHub webhooks to iterate's App: a signed delivery lands once on the routed connection's log", async () => {
  const { member } = await githubInstalled("github-webhooks", { installationId: "9003" });
  const push = { ref: "refs/heads/main", installation: { id: 9003 } };
  for (const attempt of [1, 2]) {
    const delivered = await githubPost(GITHUB_WEBHOOK, push, ITERATE_GITHUB_WEBHOOK_SECRET, "d-1");
    expect(await delivered.json(), `delivery ${attempt}`).toEqual({ ok: true });
  }
  expect(await webhooksOn(member.projectId, "/integrations/github/acme")).toMatchObject([
    {
      type: "events.iterate.com/github/webhook-received",
      idempotencyKey: "github-webhook:d-1",
      source: { platform: true },
      payload: { delivery: { id: "d-1", name: "push" }, installationId: "9003", body: push },
    },
  ]);
});

test.for([
  {
    name: "missing delivery headers are 400",
    secret: ITERATE_GITHUB_WEBHOOK_SECRET,
    delivery: "",
    status: 400,
    answer: { error: "Missing x-github-delivery or x-github-event." },
  },
  {
    name: "a bad signature is 401",
    secret: "not-the-webhook-secret",
    delivery: "d-2",
    status: 401,
    answer: { error: "Invalid GitHub signature." },
  },
  {
    name: "an unrouted installation is ignored",
    secret: ITERATE_GITHUB_WEBHOOK_SECRET,
    delivery: "d-3",
    status: 200,
    answer: { ok: true, ignored: "unrouted-installation" },
  },
])("GitHub webhooks to iterate's App: $name", async ({ secret, delivery, status, answer }) => {
  const push = { installation: { id: 9999 } };
  const response = await githubPost(GITHUB_WEBHOOK, push, secret, delivery);
  expect({ status: response.status, answer: await response.json() }).toEqual({ status, answer });
});

test.for<{ name: string; installation: InstallationInput; refusal: string }>([
  {
    name: "a member, not an owner, of the installation's organization",
    installation: {
      installationId: "9101",
      account: { login: "org-9101" },
      users: [{ login: "m-9101", role: "member" }],
    },
    refusal: "only an owner of org-9101 can connect its installation",
  },
  {
    name: "an admin of a user account the App is installed on that is not theirs",
    installation: {
      installationId: "9102",
      account: { login: "bob-9102", type: "User" },
      users: [{ login: "alice-9102", role: "admin" }],
    },
    refusal: "the App is installed on another user, bob-9102",
  },
])("GitHub: $name is refused at the callback", async ({ installation, refusal }) => {
  const { installationId } = installation;
  const { member, back } = await githubInstalled(`github-refused-${installationId}`, installation);
  expect({ status: back.status, text: await back.text() }).toMatchObject({
    status: 400,
    text: expect.stringContaining(refusal),
  });
  expect(await catalog().integrationRoute("github", installationId)).toBeNull();
  expect(await integrationsOf(member.itx)).toEqual({});
});

test("GitHub: a callback with an installation but no code sends the human on to authorize, and that authorization connects", async () => {
  const member = await projectWithMember("github-setup-url");
  const petshop = petshopFakes();
  const users = [{ login: "petshop-user", role: "admin" as const }];
  await registerIterateInstallation(petshop, { installationId: "9201", users });
  const { authorizationUrl } = await projectFacet(member.itx).connectIntegration({
    provider: "github",
    connection: "acme",
    client: "iterate",
    next: NEXT,
  });
  const state = new URL(authorizationUrl).searchParams.get("state")!;
  const setup = await exports.default.fetch(
    new Request(`${GITHUB_CALLBACK}?installation_id=9201&setup_action=install&state=${state}`, {
      headers: { cookie: member.cookie },
      redirect: "manual",
    }),
  );
  expect(setup, await setup.clone().text()).toMatchObject({ status: 303 });
  const authorize = new URL(setup.headers.get("location")!);
  expect({
    at: authorize.href.split("?")[0],
    ...Object.fromEntries(authorize.searchParams),
  }).toMatchObject({
    at: "https://github.test/login/oauth/authorize",
    redirect_uri: GITHUB_CALLBACK,
  });
  expect(authorize.searchParams.get("state")).not.toBe(state);
  const back = await followConsent(petshop, authorize.href, member.cookie);
  expect(back, await back.clone().text()).toMatchObject({ status: 303 });
  expect(await catalog().integrationRoute("github", "9201")).toEqual({
    projectId: member.projectId,
    path: "/integrations/github/acme",
  });
});

test("GitHub: an installation iterate's App already has connects without its configure page — the person authorizes the App at once, and the admin proof connects it", async () => {
  const member = await projectWithMember("github-installed");
  const petshop = petshopFakes();
  await registerIterateInstallation(petshop, { installationId: "9601" });
  const { authorizationUrl } = await projectFacet(member.itx).connectIntegration({
    provider: "github",
    connection: "acme",
    client: "iterate",
    next: NEXT,
    installationId: "9601",
    platformOrigin: ORIGIN,
  });
  const authorize = new URL(authorizationUrl);
  expect({
    at: authorize.href.split("?")[0],
    ...Object.fromEntries(authorize.searchParams),
  }).toMatchObject({
    at: "https://github.test/login/oauth/authorize",
    redirect_uri: GITHUB_CALLBACK,
  });
  const back = await followConsent(petshop, `${authorizationUrl}&login=admin-9601`, member.cookie);
  expect(back, await back.clone().text()).toMatchObject({ status: 303 });
  expect(await catalog().integrationRoute("github", "9601")).toEqual({
    projectId: member.projectId,
    path: "/integrations/github/acme",
  });
});

test("GitHub: an installation another project holds is offered to move here; confirming moves its webhooks here in one step and disconnects the other project's connection, and the offer works once", async () => {
  const { member: holder, petshop } = await githubInstalled("github-held", {
    installationId: "9701",
  });
  const mover = await otherProject(holder, "github-mover");
  // the same person proves they administer it, for the second project
  const back = await consented(petshop, mover, "github", "installation_id=9701");
  expect(back, await back.clone().text()).toMatchObject({ status: 303 });
  const landing = new URL(back.headers.get("location")!);
  expect(landing.href.split("?")[0]).toBe(NEXT);
  const offer = landing.searchParams.get("move")!;
  expect(JSON.parse(atob(base64(offer.split(".")[0]!)))).toMatchObject({
    kind: "github-move",
    account: "org-9701",
    holderSlug: "github-held",
  });
  // nothing moved yet: the holder keeps its route and its row
  expect(await catalog().integrationRoute("github", "9701")).toMatchObject({
    projectId: holder.projectId,
  });
  expect(await integrationsOf(mover.itx)).toEqual({});

  await projectFacet(mover.itx).confirmGithubMove({ offer });
  expect(await catalog().integrationRoute("github", "9701")).toEqual({
    projectId: mover.projectId,
    path: "/integrations/github/acme",
  });
  await vi.waitFor(async () => {
    expect(await integrationsOf(mover.itx)).toMatchObject({
      "/integrations/github/acme": { account: "org-9701", externalId: "9701" },
    });
    expect(await integrationsOf(holder.itx)).toEqual({});
  });
  expect(await disconnectedFacts(holder.projectId)).toEqual([
    { connection: "acme", reason: "moved" },
  ]);
  const push = { installation: { id: 9701 } };
  await githubPost(GITHUB_WEBHOOK, push, ITERATE_GITHUB_WEBHOOK_SECRET, "d-move");
  expect(await webhooksOn(mover.projectId, "/integrations/github/acme")).toHaveLength(1);
  expect(await webhooksOn(holder.projectId, "/integrations/github/acme")).toEqual([]);
  // the offer is spent
  await expect(projectFacet(mover.itx).confirmGithubMove({ offer })).rejects.toThrow(/expired/);
});

test("GitHub: an offer for an installation its holder has since given up moves nothing, and leaves the holder's new installation alone", async () => {
  const { member: holder, petshop } = await githubInstalled("github-stale", {
    installationId: "9801",
  });
  const mover = await otherProject(holder, "github-stale-mover");
  const back = await consented(petshop, mover, "github", "installation_id=9801");
  const offer = new URL(back.headers.get("location")!).searchParams.get("move")!;
  // the holder's connection takes another installation meanwhile
  await registerIterateInstallation(petshop, { installationId: "9802" });
  await connected(petshop, holder, "github", "installation_id=9802");
  await expect(projectFacet(mover.itx).confirmGithubMove({ offer })).rejects.toThrow(
    /moved meanwhile/,
  );
  expect(await catalog().integrationRoute("github", "9801")).toBeNull();
  expect(await catalog().integrationRoute("github", "9802")).toEqual({
    projectId: holder.projectId,
    path: "/integrations/github/acme",
  });
  await vi.waitFor(async () =>
    expect(await integrationsOf(holder.itx)).toMatchObject({
      "/integrations/github/acme": { externalId: "9802" },
    }),
  );
  expect(await disconnectedFacts(holder.projectId)).toEqual([]);
});

test("GitHub: the project that lost an installation stops using it, even at another secret path it minted it at, within the route re-check", async () => {
  const { member: holder, petshop } = await githubInstalled("github-lost", {
    installationId: "9811",
  });
  // a second path of the holder's own, minting the same installation while it holds it
  await holder.itx.secrets.set(
    "/secrets/github-copy",
    {},
    {
      urls: ["https://github.test"],
      refresh: {
        kind: "github-app-installation",
        apiOrigin: "https://github.test",
        installationId: "9811",
        client: { platform: "github" },
      },
    },
  );
  expect(await installationRepositories(holder.itx, "/secrets/github-copy")).toMatchObject({
    status: 200,
  });
  const mover = await otherProject(holder, "github-lost-mover");
  const back = await consented(petshop, mover, "github", "installation_id=9811");
  const offer = new URL(back.headers.get("location")!).searchParams.get("move")!;
  await projectFacet(mover.itx).confirmGithubMove({ offer });
  // past the re-check, within the token's own life (the fake's installation tokens last 60 s)
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => void vi.useRealTimers());
  vi.setSystemTime(Date.now() + 31_000);
  const refused = await installationRepositories(holder.itx, "/secrets/github-copy");
  vi.useRealTimers();
  expect({ status: refused.status, text: await refused.text() }).toMatchObject({
    status: 502,
    text: expect.stringContaining("not connected to this project"),
  });
});

test("GitHub: a secret that minted an installation's token and is set again without its refresh keeps no token, so it cannot use the installation once it moved", async () => {
  const { member: holder, petshop } = await githubInstalled("github-strip", {
    installationId: "9841",
  });
  await holder.itx.secrets.set(
    "/secrets/github-copy",
    {},
    {
      urls: ["https://github.test"],
      refresh: {
        kind: "github-app-installation",
        apiOrigin: "https://github.test",
        installationId: "9841",
        client: { platform: "github" },
      },
    },
  );
  expect(await installationRepositories(holder.itx, "/secrets/github-copy")).toMatchObject({
    status: 200,
  });
  // merged over, the refresh left out: what it minted goes with it
  await holder.itx.secrets.set(
    "/secrets/github-copy",
    {},
    { urls: ["https://github.test"], merge: true },
  );
  const mover = await otherProject(holder, "github-strip-mover");
  const back = await consented(petshop, mover, "github", "installation_id=9841");
  const offer = new URL(back.headers.get("location")!).searchParams.get("move")!;
  await projectFacet(mover.itx).confirmGithubMove({ offer });
  const refused = await installationRepositories(holder.itx, "/secrets/github-copy");
  expect({ status: refused.status, text: await refused.text() }).toMatchObject({
    status: 502,
    text: expect.stringContaining("accessToken"),
  });
});

test("GitHub: the holder reconnecting to another installation while a move's cleanup runs there keeps that installation", async () => {
  const { member: holder, petshop } = await githubInstalled("github-race", {
    installationId: "9851",
  });
  const mover = await otherProject(holder, "github-race-mover");
  const back = await consented(petshop, mover, "github", "installation_id=9851");
  const offer = new URL(back.headers.get("location")!).searchParams.get("move")!;
  await registerIterateInstallation(petshop, { installationId: "9852" });
  // The cleanup's route release (the first delete of a route here) waits for the reconnect, or
  // two seconds for a reconnect that waits for the cleanup. Flags, polled: a promise one side
  // resolves would run the other's continuation in the wrong Durable Object's I/O context.
  let cleanupReached = false;
  let reconnected = false;
  const prepare = env.DB.prepare.bind(env.DB);
  const prepares = vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
    const statement = prepare(sql);
    if (!sql.startsWith("delete from integration_routes") || /exists|not in/.test(sql))
      return statement;
    prepares.mockRestore();
    const bind = statement.bind.bind(statement);
    statement.bind = (...args: unknown[]) => {
      const bound = bind(...args);
      const run = bound.run.bind(bound);
      bound.run = (async () => {
        cleanupReached = true;
        for (const until = Date.now() + 2_000; !reconnected && Date.now() < until;)
          await scheduler.wait(20);
        return run();
      }) as typeof bound.run;
      return bound;
    };
    return statement;
  });
  onTestFinished(() => prepares.mockRestore());
  const moved = projectFacet(mover.itx).confirmGithubMove({ offer });
  await vi.waitFor(() => expect(cleanupReached).toBe(true));
  await connected(petshop, holder, "github", "installation_id=9852");
  reconnected = true;
  await moved;
  await vi.waitFor(async () =>
    expect(await integrationsOf(holder.itx)).toMatchObject({
      "/integrations/github/acme": { externalId: "9852" },
    }),
  );
  expect(await catalog().integrationRoute("github", "9852")).toEqual({
    projectId: holder.projectId,
    path: "/integrations/github/acme",
  });
  expect(await installationRepositories(holder.itx, "/secrets/github-acme")).toMatchObject({
    status: 200,
  });
});

test("GitHub: a move whose cleanup at the holder fails says so, and the same offer finishes it", async () => {
  const { member: holder, petshop } = await githubInstalled("github-cleanup", {
    installationId: "9821",
  });
  const mover = await otherProject(holder, "github-cleanup-mover");
  const back = await consented(petshop, mover, "github", "installation_id=9821");
  const offer = new URL(back.headers.get("location")!).searchParams.get("move")!;
  const holderRoot = stub(holder.projectId);
  await holderRoot.append({ type: "events.iterate.com/itx/paused", payload: { reason: "test" } });
  await expect(projectFacet(mover.itx).confirmGithubMove({ offer })).rejects.toThrow(
    /press Move again/,
  );
  // moved already: the route is the mover's
  expect(await catalog().integrationRoute("github", "9821")).toMatchObject({
    projectId: mover.projectId,
  });
  await holderRoot.append({ type: "events.iterate.com/itx/resumed", payload: {} });
  await projectFacet(mover.itx).confirmGithubMove({ offer });
  await vi.waitFor(async () => expect(await integrationsOf(holder.itx)).toEqual({}));
  expect(await disconnectedFacts(holder.projectId)).toEqual([
    { connection: "acme", reason: "moved" },
  ]);
  // done: the offer is spent now
  await expect(projectFacet(mover.itx).confirmGithubMove({ offer })).rejects.toThrow(/expired/);
});

test("GitHub: a move that fails to connect puts both installations' routes back where they were", async () => {
  const { member: holder, petshop } = await githubInstalled("github-restore", {
    installationId: "9831",
  });
  const mover = await otherProject(holder, "github-restore-mover");
  await registerIterateInstallation(petshop, { installationId: "9832" });
  await connected(petshop, mover, "github", "installation_id=9832");
  const back = await consented(petshop, mover, "github", "installation_id=9831");
  const offer = new URL(back.headers.get("location")!).searchParams.get("move")!;
  // the installation's key no longer verifies: minting its first token here fails
  await petshop.state.registerApp({
    publicKeyPem: "not a key",
    appId: "github-test-app",
    appSlug: "iterate-test",
    callbackUrl: GITHUB_CALLBACK,
    installationId: "9831",
    account: { login: "org-9831" },
    users: [{ login: "admin-9831", role: "admin" }],
  });
  await expect(projectFacet(mover.itx).confirmGithubMove({ offer })).rejects.toThrow(
    /Minting the installation's token failed/,
  );
  expect(await catalog().integrationRoute("github", "9831")).toEqual({
    projectId: holder.projectId,
    path: "/integrations/github/acme",
  });
  expect(await catalog().integrationRoute("github", "9832")).toEqual({
    projectId: mover.projectId,
    path: "/integrations/github/acme",
  });
});

test("GitHub: a move offer is refused for another project, and one someone forged", async () => {
  const { member: holder, petshop } = await githubInstalled("github-held-2", {
    installationId: "9702",
  });
  const mover = await otherProject(holder, "github-mover-2");
  const back = await consented(petshop, mover, "github", "installation_id=9702");
  const offer = new URL(back.headers.get("location")!).searchParams.get("move")!;
  const third = await otherProject(holder, "github-third-2");
  await expect(projectFacet(third.itx).confirmGithubMove({ offer })).rejects.toThrow(/expired/);
  const [payload, signature] = offer.split(".");
  const forged = `${btoa(atob(base64(payload!)).replace("github-held-2", "x")).replaceAll("=", "")}.${signature}`;
  await expect(projectFacet(mover.itx).confirmGithubMove({ offer: forged })).rejects.toThrow(
    /expired/,
  );
  expect(await catalog().integrationRoute("github", "9702")).toMatchObject({
    projectId: holder.projectId,
  });
});

test("GitHub: a secret in another project naming iterate's App and a routed installation cannot mint", async () => {
  const { member } = await githubInstalled("github-mint-gate", { installationId: "9301" });
  const other = await otherProject(member, "github-mint-thief");
  const refresh = {
    kind: "github-app-installation",
    apiOrigin: "https://github.test",
    installationId: "9301",
    client: { platform: "github" },
  } as const;
  await other.itx.secrets.set("/secrets/github-x", {}, { urls: ["https://github.test"], refresh });
  const minted = await installationRepositories(other.itx, "/secrets/github-x");
  expect({ status: minted.status, text: await minted.text() }).toMatchObject({
    status: 502,
    text: expect.stringContaining("GitHub installation 9301 is not connected to this project"),
  });
});

// The connect's own proof mints once, with the key the merged secret still holds, which only the
// project's App's public half (registered at the fake) verifies.
test("GitHub, the project's own App: the user token is exchanged with its client secret, and its key mints", async () => {
  const { member, petshop, app } = await githubOwnApp("github-own");
  await vi.waitFor(async () =>
    expect(await integrationsOf(member.itx)).toMatchObject({
      "/integrations/github/acme": { client: "project", account: "own-org", externalId: "9401" },
    }),
  );
  const exchange = petshop.requests.find(({ url }) => url.includes("/login/oauth/access_token"))!;
  expect(Object.fromEntries(new URL(exchange.url).searchParams)).toMatchObject({
    client_id: app.clientId,
    client_secret: app.clientSecret,
  });
  expect(await catalog().integrationRoute("github", "9401")).toBeNull();
});

test.for([
  { name: "its own installation's delivery lands", installation: 9401, ignored: undefined },
  { name: "another installation's is ignored", installation: 9999, ignored: "other-installation" },
])("GitHub, the project's own App's webhook: $name", async ({ installation, ignored }) => {
  const { member } = await githubOwnApp(`github-own-webhook-${installation}`);
  const url = `${GITHUB_WEBHOOK}/${member.projectId}/acme`;
  const push = { installation: { id: installation } };
  const answer = await (await githubPost(url, push, "own-webhook-secret", "d-own")).json();
  expect(answer).toEqual({ ok: true, ignored });
  expect(await webhooksOn(member.projectId, "/integrations/github/acme")).toMatchObject(
    ignored ? [] : [{ idempotencyKey: "github-webhook:d-own" }],
  );
});

// A self-host names no `urls.os`: the platform origin is the one GitHub's redirect reached.
test("GitHub on a deployment with no urls.os: connect, and the callback authorizes at the request's origin", async () => {
  const scope = githubScopeWithoutUrlsOs();
  const { authorizationUrl } = await connectGithub(scope, {
    connection: "acme",
    client: "iterate",
    next: `${SELF_HOST}/integrations`,
  });
  expect(authorizationUrl).toMatch(
    /^https:\/\/github\.test\/apps\/iterate-test\/installations\/new\?/,
  );
  const { nonce } = (await scope.storage.get<{ nonce: string }>(
    "integration-attempt:github/acme",
  ))!;
  const { redirect } = await acceptGithubCallback(scope, {
    platformOrigin: SELF_HOST,
    connection: "acme",
    nonce,
    installationId: "9501",
  });
  expect(Object.fromEntries(new URL(redirect!).searchParams)).toMatchObject({
    redirect_uri: `${SELF_HOST}/api/integrations/github/callback`,
  });
});

type Member = Awaited<ReturnType<typeof projectWithMember>>;
type Petshop = ReturnType<typeof petshopFakes>;
type ConnectInput = Parameters<ProjectDurableObject["connectIntegration"]>[0];
type InstallationInput = Omit<Parameters<Petshop["state"]["registerApp"]>[0], "publicKeyPem"> & {
  installationId: string;
};

/** The project facet on `/`, as a member reaches it (its `publicMethods`). */
function projectFacet(itx: Member["itx"]) {
  // `facets.get` answers the SDK's facet shell over the wire; the class it hosts is ours.
  return itx.cd("/").facets.get("project") as Pick<
    ProjectDurableObject,
    "connectIntegration" | "disconnectIntegration" | "confirmGithubMove"
  > & { snapshot(): Promise<{ state: ProjectState }> };
}

async function integrationsOf(itx: Member["itx"]) {
  return (await projectFacet(itx).snapshot()).state.integrations;
}

async function secretPathsOf(itx: Member["itx"]): Promise<string[]> {
  return (await itx.secrets.list()).map((secret: { path: string }) => secret.path);
}

/** Another project of the same member. */
async function otherProject(member: Member, slug: string): Promise<Member> {
  const itx = await member.session.projects.create({ project: slug });
  return { ...member, itx, projectId: (await itx.whoami()).projectId };
}

/** Connect `acme` (iterate's app unless `input` says otherwise), then the human's consent through
 *  the platform's callback; `query` picks the account at the fake (`team=`, `email=`,
 *  `installation_id=`). Answers the callback's last response. */
async function consented(
  petshop: Petshop,
  member: Member,
  provider: ConnectInput["provider"],
  query: string,
  input: Partial<ConnectInput> = {},
) {
  const { authorizationUrl } = await projectFacet(member.itx).connectIntegration({
    provider,
    connection: "acme",
    client: "iterate",
    next: NEXT,
    ...input,
  });
  return followConsent(petshop, `${authorizationUrl}&${query}`, member.cookie);
}

async function connected(...args: Parameters<typeof consented>) {
  const back = await consented(...args);
  expect(back, await back.clone().text()).toMatchObject({ status: 303 });
}

/** A project connected to Slack workspace T3OWN through its own app, `/secrets/slack-acme`. */
async function slackOwnApp(slug: string) {
  const member = await projectWithMember(slug);
  const petshop = petshopFakes();
  const app = await petshop.state.createClient({});
  const material = { ...app, signingSecret: "own-signing-secret" };
  await member.itx.secrets.set("/secrets/slack-acme", material, { urls: ["https://slack.test"] });
  await connected(petshop, member, "slack", "team=T3OWN", { client: "project" });
  return { member, petshop, app };
}

/** A project connected to jonas@example.test through iterate's Google client. */
async function googleConnected(slug: string) {
  const member = await projectWithMember(slug);
  const petshop = petshopFakes();
  await connected(petshop, member, "google", "email=jonas@example.test");
  return { member, petshop };
}

async function gmailProfile(itx: Member["itx"]) {
  const response: Response = await itx.fetch(
    new Request("https://google.test/gmail/v1/users/me/profile", {
      headers: { authorization: bearerOf("/secrets/google-acme") },
    }),
  );
  return response.json();
}

function installationRepositories(itx: Member["itx"], secretPath: string): Promise<Response> {
  return itx.fetch(
    new Request("https://github.test/installation/repositories", {
      headers: { authorization: bearerOf(secretPath) },
    }),
  );
}

const bearerOf = (secretPath: string) =>
  `Bearer getSecret("${secretPath}", { field: "accessToken" })`;

/** Each grant the Google fake's token endpoint was sent, with its HTTP Basic client. */
function tokenGrantsOf(petshop: Petshop) {
  return petshop.requests
    .filter(({ url }) => url === "https://google.test/token")
    .map(({ body, headers }) => ({
      grant: new URLSearchParams(body).get("grant_type"),
      client: atob(headers.authorization!.replace(/^Basic /, "")),
    }));
}

/** An installation of iterate's App (its key's public half is the fake's) on organization
 *  `org-<id>`, administered by `admin-<id>`, unless `installation` says otherwise. */
function registerIterateInstallation(petshop: Petshop, installation: InstallationInput) {
  return petshop.state.registerApp({
    publicKeyPem: env.TEST_GITHUB_APP_PUBLIC_KEY!,
    appId: "github-test-app",
    appSlug: "iterate-test",
    callbackUrl: GITHUB_CALLBACK,
    account: { login: `org-${installation.installationId}` },
    users: [{ login: `admin-${installation.installationId}`, role: "admin" }],
    ...installation,
  });
}

/** A member installs iterate's App (`registerIterateInstallation`); `back` is the callback's last
 *  response. */
async function githubInstalled(slug: string, installation: InstallationInput) {
  const member = await projectWithMember(slug);
  const petshop = petshopFakes();
  await registerIterateInstallation(petshop, installation);
  const query = `installation_id=${installation.installationId}`;
  return { member, petshop, back: await consented(petshop, member, "github", query) };
}

/** A project connected to installation 9401 of its own App: `/secrets/github-acme` holds the App (a
 *  key pair made here), whose OAuth client is a fresh one at the fake. */
async function githubOwnApp(slug: string) {
  const member = await projectWithMember(slug);
  const petshop = petshopFakes();
  const client = await petshop.state.createClient({});
  const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048 };
  const keys = (await crypto.subtle.generateKey(
    { ...algorithm, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pemOf = async (label: string, format: "pkcs8" | "spki", key: CryptoKey) => {
    const der = new Uint8Array((await crypto.subtle.exportKey(format, key)) as ArrayBuffer);
    const body = btoa(String.fromCharCode(...der)).replace(/.{64}/g, "$&\n");
    return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
  };
  const privateKey = await pemOf("PRIVATE KEY", "pkcs8", keys.privateKey);
  const app = { appId: "own-app", ...client, privateKey, webhookSecret: "own-webhook-secret" };
  await member.itx.secrets.set("/secrets/github-acme", app, { urls: ["https://github.test"] });
  await petshop.state.registerApp({
    publicKeyPem: await pemOf("PUBLIC KEY", "spki", keys.publicKey),
    appId: "own-app",
    installationId: "9401",
    appSlug: "own-bot",
    callbackUrl: GITHUB_CALLBACK,
    oauthClientId: client.clientId,
    account: { login: "own-org" },
    users: [{ login: "own-admin", role: "admin" }],
  });
  const own = { client: "project", appSlug: "own-bot", clientId: client.clientId } as const;
  await connected(petshop, member, "github", "installation_id=9401", own);
  return { member, petshop, app };
}

/** A webhook signed the way Slack signs, `secondsAgo` old. */
function slackPost(url: string, body: unknown, signingSecret: string, secondsAgo = 0) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000) - secondsAgo);
  const signature = createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${raw}`)
    .digest("hex");
  const headers = {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${signature}`,
  };
  return exports.default.fetch(new Request(url, { method: "POST", headers, body: raw }));
}

/** A `push` delivery signed the way GitHub signs, `delivery` its id. */
function githubPost(url: string, body: unknown, webhookSecret: string, delivery: string) {
  const raw = JSON.stringify(body);
  const headers = {
    "x-hub-signature-256": `sha256=${createHmac("sha256", webhookSecret).update(raw).digest("hex")}`,
    "x-github-event": "push",
    "x-github-delivery": delivery,
  };
  return exports.default.fetch(new Request(url, { method: "POST", headers, body: raw }));
}

/** The webhooks on a connection's log, as the platform appended them. */
async function webhooksOn(projectId: string, path: string) {
  const { events } = (await stub(DurableObjectNameCodec.stringify({ projectId, path })).invoke([
    "itx",
    ["readEvents", 0, 500],
  ])) as { events: StreamEvent[] };
  return events.filter((event) => event.type.endsWith("/webhook-received"));
}

const SELF_HOST = "https://iterate.self-host.test";

/** GitHub's connect and callback run directly on a deployment whose APP_CONFIG names no `urls.os`
 *  (a self-host's), with an in-memory attempt store: the project facet's own env names one. */
function githubScopeWithoutUrlsOs(): IntegrationScope {
  const kept = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => kept.get(key),
    put: async (key: string, value: unknown) => void kept.set(key, value),
    delete: async (key: string) => kept.delete(key),
  } as unknown as DurableObjectStorage;
  return {
    // a self-host's shape: no urls.os, so neither test links nor admins beside the global password
    // (app-config.ts refuses both off a preview, local or `.test` origin)
    env: {
      ...env,
      APP_CONFIG_URLS__OS: "",
      APP_CONFIG_LOGIN__TEST_LINK__EMAIL_DOMAIN: undefined,
      APP_CONFIG_ADMINS: undefined,
    },
    projectId: "prj_selfhost",
    rootPath: "/",
    withItx: () => Promise.reject(new Error("no itx in this test")),
    storage,
  };
}

/** base64url → base64, for `atob`. */
function base64(base64url: string) {
  const plain = base64url.replaceAll("-", "+").replaceAll("_", "/");
  return plain + "=".repeat((4 - (plain.length % 4)) % 4);
}

/** Every `github/disconnected` on a project's root. */
async function disconnectedFacts(projectId: string) {
  return (await readLog(projectId))
    .filter((event) => event.type === "events.iterate.com/github/disconnected")
    .map((event) => event.payload);
}
