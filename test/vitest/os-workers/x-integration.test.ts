import { expect, test } from "vitest";
import { DEFAULT_X_SCOPES } from "../../../core/os/src/app-config.ts";
import {
  catalog,
  followConsent,
  ORIGIN,
  petshopFakes,
  projectWithMember,
  readLog,
  until,
} from "./support.ts";

test.for([
  { name: "Iterate's app", client: "iterate" as const },
  { name: "a project's app", client: "project" as const },
])("X through $name verifies identity and refreshes the stored token", async ({ client }) => {
  const member = await projectWithMember(`x-${client}`);
  const petshop = petshopFakes();
  if (client === "project")
    await member.itx.secrets.set(
      "/secrets/x-bot",
      {
        clientId: "petshop-default",
        clientSecret: "petshop-default-secret",
      },
      { urls: ["https://x.test"] },
    );
  const { authorizationUrl } = await member.itx.integrations.connect("x", {
    connection: "bot",
    client,
    scopes: ["tweet.write"],
    next: `${ORIGIN}/done`,
  });
  expect(Object.fromEntries(new URL(authorizationUrl).searchParams)).toMatchObject({
    code_challenge_method: "S256",
    redirect_uri: `${ORIGIN}/api/integrations/x/callback`,
    scope: DEFAULT_X_SCOPES.join(" "),
  });
  const back = await followConsent(
    petshop,
    `${authorizationUrl}&user=100&username=iteratebot`,
    member.cookie,
  );
  expect(back, await back.clone().text()).toMatchObject({ status: 303 });
  expect(await readLog(member.projectId)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "events.iterate.com/x/connected",
        source: expect.objectContaining({ platform: true }),
        payload: expect.objectContaining({ externalId: "100", account: "@iteratebot", client }),
      }),
    ]),
  );
  const me = () =>
    member.itx.fetch(
      new Request("https://x.test/2/users/me", {
        headers: { authorization: 'Bearer getSecret("/secrets/x-bot", { field: "accessToken" })' },
      }),
    );
  await petshop.state.expireAccessTokens("petshop-default", "100");
  expect(await (await me()).json()).toMatchObject({ data: { id: "100", username: "iteratebot" } });
  const exchange = petshop.requests.filter((r) => r.url.endsWith("/2/oauth2/token"));
  expect(exchange).toHaveLength(2);
  expect(exchange.at(-1)).toMatchObject({
    headers: { authorization: expect.stringMatching(/^Basic /) },
    body: expect.stringContaining("grant_type=refresh_token"),
  });
});

test("X reconnect refuses a different account before replacing the existing credential", async () => {
  const member = await projectWithMember("x-reconnect");
  const petshop = petshopFakes();
  const first = await member.itx.integrations.connect("x", {
    connection: "bot",
    next: `${ORIGIN}/done`,
  });
  expect(
    await followConsent(petshop, `${first.authorizationUrl}&user=110`, member.cookie),
  ).toMatchObject({ status: 303 });
  const second = await member.itx.integrations.connect("x", {
    connection: "bot",
    scopes: ["tweet.write"],
  });
  const refused = await followConsent(
    petshop,
    `${second.authorizationUrl}&user=210`,
    member.cookie,
  );
  expect({ status: refused.status, body: await refused.text() }).toMatchObject({
    status: 400,
    body: expect.stringContaining("different account"),
  });
  const me = await member.itx.fetch(
    new Request("https://x.test/2/users/me", {
      headers: { authorization: 'Bearer getSecret("/secrets/x-bot", { field: "accessToken" })' },
    }),
  );
  expect(await me.json()).toMatchObject({ data: { id: "110" } });
});

test("a person's verified X account can be lent to a project and revoked", async () => {
  const member = await projectWithMember("x-personal");
  const petshop = petshopFakes();
  const { authorizationUrl } = await member.session.user.integrations.connect("x", {
    connection: "me",
    next: `${ORIGIN}/done`,
  });
  expect(
    await followConsent(petshop, `${authorizationUrl}&user=12345&username=jonas`, member.cookie),
  ).toMatchObject({ status: 303 });
  expect(await member.itx.integrations.connect("x", { account: "@jonas" })).toMatchObject({
    connection: "me",
  });
  const { actor } = await member.session.whoami();
  expect(await readLog(member.projectId)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "events.iterate.com/x/connected",
        payload: expect.objectContaining({ externalId: "12345", ownerUserId: actor }),
      }),
    ]),
  );
  const me = () =>
    member.itx.fetch(
      new Request("https://x.test/2/users/me", {
        headers: { authorization: 'Bearer getSecret("/secrets/x-me", { field: "accessToken" })' },
      }),
    );
  expect(await (await me()).json()).toMatchObject({ data: { id: "12345" } });
  await member.session.user.integrations.disconnect("x", "me");
  await until(
    "X's personal token is no longer usable by the project",
    async () => (await me()).status === 502,
  );
});

test("personal X identity cannot be established through a customer's OAuth client", async () => {
  const member = await projectWithMember("x-personal-byo");
  await expect(
    member.session.user.integrations.connect("x", { connection: "me", client: "project" }),
  ).rejects.toThrow("Link your X identity through Iterate's X app");
});

test.for([
  { name: "personal reconnect", viaProject: false },
  { name: "project-requested scope upgrade", viaProject: true },
])("$name preserves the original X account and project access", async ({ viaProject }) => {
  const member = await projectWithMember("x-personal-reconnect");
  const petshop = petshopFakes();
  const first = await member.session.user.integrations.connect("x", {
    connection: "me",
    next: `${ORIGIN}/done`,
  });
  expect(
    await followConsent(
      petshop,
      `${first.authorizationUrl}&user=12345&username=jonas`,
      member.cookie,
    ),
  ).toMatchObject({ status: 303 });
  await member.itx.integrations.connect("x", { account: "@jonas" });
  const second = viaProject
    ? await member.itx.integrations.connect("x", { account: "@jonas", scopes: ["mute.read"] })
    : await member.session.user.integrations.connect("x", {
        connection: "me",
        scopes: ["mute.read"],
      });
  const refused = await followConsent(
    petshop,
    `${second.authorizationUrl}&user=67890`,
    member.cookie,
  );
  expect({ status: refused.status, body: await refused.text() }).toMatchObject({
    status: 400,
    body: expect.stringContaining("different account"),
  });
  const response = await member.itx.fetch(
    new Request("https://x.test/2/users/me", {
      headers: { authorization: 'Bearer getSecret("/secrets/x-me", { field: "accessToken" })' },
    }),
  );
  expect(await response.json()).toMatchObject({ data: { id: "12345" } });
});

test("an X account is one connection: a second is refused here and in another project, and free again once disconnected", async () => {
  const member = await projectWithMember("x-route-here");
  const other = await projectWithMember("x-route-elsewhere");
  const petshop = petshopFakes();
  const connect = async (who: typeof member, connection: string) =>
    followConsent(
      petshop,
      `${(await who.itx.integrations.connect("x", { connection, next: `${ORIGIN}/done` })).authorizationUrl}&user=300&username=jonas`,
      who.cookie,
    );
  const paths = async () =>
    (await member.itx.secrets.list()).map((secret: { path: string }) => secret.path);
  expect(await connect(member, "one")).toMatchObject({ status: 303 });
  const again = await connect(member, "two");
  expect({ status: again.status, body: await again.text() }).toMatchObject({
    status: 400,
    body: expect.stringContaining("already connected at"),
  });
  expect(await paths()).toEqual(expect.arrayContaining(["/secrets/x-one"]));
  expect(await paths()).not.toContain("/secrets/x-two");
  const elsewhere = await connect(other, "one");
  expect({ status: elsewhere.status, body: await elsewhere.text() }).toMatchObject({
    status: 400,
    body: expect.stringContaining("connected to another project"),
  });
  await member.itx.integrations.disconnect("x", "one");
  expect(await connect(other, "one")).toMatchObject({ status: 303 });
});

test("a refused reconnect of an X connection that lost its route keeps the connection's token", async () => {
  const member = await projectWithMember("x-route-lost");
  const other = await projectWithMember("x-route-took");
  const petshop = petshopFakes();
  const consent = async (who: typeof member, scopes?: string[]) =>
    followConsent(
      petshop,
      `${(await who.itx.integrations.connect("x", { connection: "one", scopes, next: `${ORIGIN}/done` })).authorizationUrl}&user=320&username=jonas`,
      who.cookie,
    );
  expect(await consent(member)).toMatchObject({ status: 303 });
  // a connection made before X was routed holds no route: another project takes the account
  await catalog().releaseIntegrationRoutes(member.projectId, "/integrations/x/one");
  expect(await consent(other)).toMatchObject({ status: 303 });
  const refused = await consent(member, ["tweet.write"]);
  expect({ status: refused.status, body: await refused.text() }).toMatchObject({
    status: 400,
    body: expect.stringContaining("connected to another project"),
  });
  const me = await member.itx.fetch(
    new Request("https://x.test/2/users/me", {
      headers: { authorization: 'Bearer getSecret("/secrets/x-one", { field: "accessToken" })' },
    }),
  );
  expect(await me.json()).toMatchObject({ data: { id: "320" } });
});
