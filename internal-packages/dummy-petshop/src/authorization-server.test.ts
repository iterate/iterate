/**
 * Token expiry at the fakes' one authorization server (authorization-server.ts), through the
 * Google, Cloudflare and GitHub fakes: one account's tokens of one client. Why a test expires an
 * account: state.ts `PetshopState.accessTokenEpochs`.
 */
import { expect, test } from "vitest";
import { memoryPetshop } from "./memory-state.ts";
import { DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET } from "./state.ts";

const SIGN_IN_FAKES = [
  {
    name: "Google",
    authorize: "/o/oauth2/v2/auth",
    pick: "email",
    ada: "ada@petshop.test",
    bo: "bo@petshop.test",
    token: "/token",
    api: "/oauth2/v2/userinfo",
  },
  {
    name: "Cloudflare",
    authorize: "/cloudflare/oauth2/auth",
    pick: "email",
    ada: "ada@petshop.test",
    bo: "bo@petshop.test",
    token: "/cloudflare/oauth2/token",
    api: "/client/v4/user",
  },
  {
    name: "GitHub",
    authorize: "/login/oauth/authorize",
    pick: "login",
    ada: "ada",
    bo: "bo",
    token: "/login/oauth/access_token",
    api: "/user",
  },
];

test.for(SIGN_IN_FAKES)(
  "$name: expiring one account's tokens of a client leaves other accounts and clients live",
  async (fake) => {
    const petshop = memoryPetshop();
    const minted = await petshop.state.createClient({});
    const tokens = {
      ada: await accessTokenOf(petshop, fake, SEEDED, fake.ada),
      bo: await accessTokenOf(petshop, fake, SEEDED, fake.bo),
      adaAtAnotherClient: await accessTokenOf(petshop, fake, minted, fake.ada),
    };

    await petshop.state.expireAccessTokens(DEFAULT_CLIENT_ID, fake.ada);

    expect(await statusesOf(petshop, fake, tokens)).toEqual({
      ada: 401,
      bo: 200,
      adaAtAnotherClient: 200,
    });
  },
);

type Fake = (typeof SIGN_IN_FAKES)[number];
type Petshop = ReturnType<typeof memoryPetshop>;

const ORIGIN = "https://petshop.test";
const REDIRECT_URI = "https://app.test/callback";
const SEEDED = { clientId: DEFAULT_CLIENT_ID, clientSecret: DEFAULT_CLIENT_SECRET };

/** `account` consents at `fake` for `client`, whose code is exchanged: its access token. */
async function accessTokenOf(
  petshop: Petshop,
  fake: Fake,
  client: { clientId: string; clientSecret: string },
  account: string,
): Promise<string> {
  const authorize = new URL(fake.authorize, ORIGIN);
  authorize.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: REDIRECT_URI,
    [fake.pick]: account,
  }).toString();
  const consent = await petshop.handle(new Request(authorize));
  const code = new URL(consent!.headers.get("location")!).searchParams.get("code")!;
  const exchange = await petshop.handle(
    new Request(new URL(fake.token, ORIGIN), {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: client.clientId,
        client_secret: client.clientSecret,
      }),
    }),
  );
  // every fake answers its token as `access_token`
  return ((await exchange!.json()) as { access_token: string }).access_token;
}

/** The status `fake`'s API answers each token with. */
async function statusesOf(petshop: Petshop, fake: Fake, tokens: Record<string, string>) {
  const statuses: Record<string, number> = {};
  for (const [name, token] of Object.entries(tokens)) {
    const answer = await petshop.handle(
      new Request(new URL(fake.api, ORIGIN), { headers: { authorization: `Bearer ${token}` } }),
    );
    statuses[name] = answer!.status;
  }
  return statuses;
}
