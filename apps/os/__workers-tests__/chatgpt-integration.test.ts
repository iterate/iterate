import { expect, test } from "vitest";
import {
  followConsent,
  ORIGIN,
  petshopFakes,
  projectWithMember,
  readLog,
  refused,
} from "./support.ts";

test("a ChatGPT plan connects through the pasted loopback address, pays for the project's Responses API requests and refreshes as the issued client", async () => {
  const member = await projectWithMember("chatgpt");
  const petshop = petshopFakes();
  const { authorizationUrl } = await member.itx.integrations.connect("chatgpt", {
    connection: "plan",
    next: `${ORIGIN}/done`,
  });
  const authorize = new URL(authorizationUrl);
  expect(`${authorize.origin}${authorize.pathname}`).toBe(
    "https://auth.openai.com/api/accounts/authorize",
  );
  expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
    client_id: "dynamic_agent_client",
    response_type: "code",
    redirect_uri: "http://127.0.0.1:1455/auth/callback",
    code_challenge_method: "S256",
    scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    resource: "https://api.openai.com/v1",
    agent_name_hint: "iterate",
    ext_agent_host_id: expect.stringMatching(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-8/),
  });
  const pasted = await consentToLoopback(
    petshop,
    `${authorizationUrl}&email=ada@example.test&user=user-ada`,
    member.cookie,
  );
  expect(`${pasted.origin}${pasted.pathname}`).toBe("http://127.0.0.1:1455/auth/callback");
  const issued = pasted.searchParams.get("client_id")!;
  expect(issued).toMatch(/^oaiapp_/);
  const back = await pastedToPlatform(petshop, pasted, member.cookie);
  expect(back, await back.clone().text()).toMatchObject({ status: 303 });
  expect(back.headers.get("location")).toBe(`${ORIGIN}/done`);
  expect(await readLog(member.projectId)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "events.iterate.com/chatgpt/connected",
        source: expect.objectContaining({ platform: true }),
        payload: expect.objectContaining({
          connection: "plan",
          client: "iterate",
          account: "ada@example.test",
          externalId: "user-ada",
          scopes: expect.arrayContaining(["chatgpt.tokens.use.direct"]),
        }),
      }),
    ]),
  );
  const respond = () =>
    member.itx.fetch(
      new Request("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          authorization: 'Bearer getSecret("/secrets/chatgpt-plan", { field: "accessToken" })',
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-6-astra",
          input: [{ role: "user", content: "ping" }],
          store: false,
          stream: true,
        }),
      }),
    );
  const answered = async () => {
    const response = await respond();
    return { status: response.status, body: await response.text() };
  };
  expect(await answered()).toMatchObject({
    status: 200,
    body: expect.stringContaining("event: response.output_text.delta"),
  });
  // the access token runs out, twice: the platform refreshes as the client OpenAI issued, by its
  // ID alone, and the second refresh spends the refresh token the first one rotated in
  for (let expiry = 0; expiry < 2; expiry++) {
    await petshop.state.expireAccessTokens(issued, "ada@example.test");
    expect(await answered()).toMatchObject({
      status: 200,
      body: expect.stringContaining('"text":"pong"'),
    });
  }
  const tokenRequests = petshop.requests.filter(
    (request) => request.url === "https://auth.openai.com/api/accounts/oauth/token",
  );
  expect(
    tokenRequests.map(({ headers, body }) => ({
      authorization: headers.authorization,
      ...Object.fromEntries(new URLSearchParams(body)),
    })),
  ).toEqual([
    expect.objectContaining({
      authorization: undefined,
      grant_type: "authorization_code",
      client_id: issued,
      redirect_uri: "http://127.0.0.1:1455/auth/callback",
      // OpenAI spends the code and answers invalid_grant to an exchange without it
      resource: "https://api.openai.com/v1",
    }),
    ...Array.from({ length: 2 }, () =>
      expect.objectContaining({
        authorization: undefined,
        grant_type: "refresh_token",
        client_id: issued,
      }),
    ),
  ]);
});

test("ChatGPT has no project app, and a pasted address whose state was forged completes nothing", async () => {
  const member = await projectWithMember("chatgpt-refused");
  const petshop = petshopFakes();
  await refused(
    () => member.itx.integrations.connect("chatgpt", { connection: "plan", client: "project" }),
    "INVALID_INPUT",
    /OpenAI registers its client/,
  );
  const { authorizationUrl } = await member.itx.integrations.connect("chatgpt", {
    connection: "plan",
    next: `${ORIGIN}/done`,
  });
  const pasted = await consentToLoopback(petshop, authorizationUrl, member.cookie);
  // the platform's signed state, its claims rewritten to send the person elsewhere
  const [claims, signature] = pasted.searchParams.get("state")!.split(".");
  const decoded = JSON.parse(atob(claims!.replaceAll("-", "+").replaceAll("_", "/")));
  const forged = btoa(JSON.stringify({ ...decoded, next: "https://evil.test/" }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  pasted.searchParams.set("state", `${forged}.${signature}`);
  const back = await pastedToPlatform(petshop, pasted, member.cookie);
  expect({ status: back.status, body: await back.text() }).toMatchObject({
    status: 400,
    body: expect.stringContaining("not one the platform issued"),
  });
  expect(
    petshop.requests.filter(
      (request) => request.url === "https://auth.openai.com/api/accounts/oauth/token",
    ),
  ).toEqual([]);
  expect(
    (await member.itx.secrets.list()).map((secret: { path: string }) => secret.path),
  ).not.toContain("/secrets/chatgpt-plan");
});

/** The address OpenAI sends the person back to after the consent at `authorizationUrl`: the
 *  loopback one, which nothing serves, and which they paste into the Dash. */
async function consentToLoopback(
  petshop: ReturnType<typeof petshopFakes>,
  authorizationUrl: string,
  cookie: string,
): Promise<URL> {
  const loopback = await followConsent(petshop, authorizationUrl, cookie);
  expect(loopback, await loopback.clone().text()).toMatchObject({ status: 302 });
  return new URL(loopback.headers.get("location")!);
}

/** The pasted address carried to the platform's callback, as the Dash sends the browser there. */
const pastedToPlatform = (petshop: ReturnType<typeof petshopFakes>, pasted: URL, cookie: string) =>
  followConsent(petshop, `${ORIGIN}/api/integrations/chatgpt/callback${pasted.search}`, cookie);
