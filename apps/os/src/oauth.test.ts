// oauth.test.ts — a grant's use as its admission reads it off the person's account: a use the
// account recorded within the hour is not recorded again, whichever isolate admits the grant next,
// and a recorded use never admits a grant whose end has landed. And an account read that stalls is
// named while it waits. The account is a fake that answers what the `account` facet's snapshot
// answers; the real one is __workers-tests__/oauth.test.ts's.
import { expect, onTestFinished, test, vi } from "vitest";
import type { AccountState } from "./account/contract.ts";
import { platformAddressesOf } from "./app-config.ts";
import type { Env } from "./env.ts";
import {
  accountStateOf,
  authorizationForToken,
  grantIsLive,
  recordGrantUse,
  type AccessGrant,
} from "./oauth.ts";
import { newPersonalAccessToken } from "./personal-access-token.ts";

test.for([
  { name: "a use the account recorded ten minutes ago", usedMinutesAgo: 10, records: 0 },
  { name: "a use the account recorded two hours ago", usedMinutesAgo: 120, records: 1 },
  { name: "a key the account never saw used", usedMinutesAgo: null, records: 1 },
])(
  "$name: the admission reads it off the account, and the use is recorded again only past the hour",
  async ({ usedMinutesAgo, records }) => {
    const account = await accountHoldingKey(usedMinutesAgo);
    const authorization = await account.admit();
    expect(authorization?.grant).toMatchObject({
      grantId: account.keyId,
      lastUsedAt: account.usedAt,
    });
    // this isolate never recorded the key's use: only the account's own record holds it off
    await recordGrantUse(account.env, authorization!.grant!);
    expect(account.appended()).toHaveLength(records);
  },
);

test("a held socket's uses: past the hour at its admission, the first is recorded and this isolate's memo holds the next off", async () => {
  const account = await accountHoldingKey(120);
  const { grant } = (await account.admit())!;
  await recordGrantUse(account.env, grant!);
  await recordGrantUse(account.env, grant!);
  expect(account.appended()).toEqual([
    {
      type: "events.iterate.com/account/grant-used",
      payload: { grantId: account.keyId, at: expect.any(Number) },
    },
  ]);
});

test("a use recorded a moment ago admits nothing once the grant has ended: its very next admission is refused", async () => {
  const account = await accountHoldingKey(0);
  const oauthGrant: AccessGrant = {
    kind: "app",
    userId: account.userId,
    email: "person@example.com",
    projects: null,
    deadline: Date.now() + 3600_000,
    grantId: "oauth-grant",
    scope: ["iterate"],
    expiresAt: Date.now() + 3600_000,
    lastUsedAt: Date.now(),
  };
  await recordGrantUse(account.env, (await account.admit())!.grant!);
  await recordGrantUse(account.env, oauthGrant);
  expect(await account.admit()).toMatchObject({ principal: { actor: account.userId } });
  expect(await grantIsLive(account.env, oauthGrant)).toBe(true);

  account.end(account.keyId);
  account.end(oauthGrant.grantId);
  expect(await account.admit()).toBeNull();
  expect(await grantIsLive(account.env, oauthGrant)).toBe(false);
});

test("an account read still waiting after five seconds names the person while it waits, and still answers", async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => void vi.useRealTimers());
  // what a brand-new account does while Cloudflare holds its first write: it answers late
  let answer!: (snapshot: { offset: number; state: Partial<AccountState> }) => void;
  const env = {
    ITERATE_CONTEXT: {
      getByName: () => ({ invoke: () => new Promise((resolve) => (answer = resolve)) }),
    },
  } as unknown as Env;
  const read = accountStateOf(env, "user_held");
  await vi.advanceTimersByTimeAsync(4_999);
  expect(warn).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(warn).toHaveBeenCalledExactlyOnceWith({
    event: "oauth.step-slow",
    step: "account-state",
    userId: "user_held",
    waitedMs: 5_000,
  });
  answer({ offset: 1, state: { endedGrants: {} } });
  expect(await read).toEqual({ endedGrants: {} });
});

/** A person's account holding one personal access token, used `usedMinutesAgo` (null: never),
 *  behind an `env` whose `ITERATE_CONTEXT` is that account's context and whose `OAUTH_KV` indexes
 *  the key. `admit` presents the key as `/api` does; `end` lands a grant's end on the account;
 *  `appended` is what the platform appended to it. */
async function accountHoldingKey(usedMinutesAgo: number | null) {
  const userId = `user_${crypto.randomUUID().replaceAll("-", "")}`;
  const { id: keyId, token, hash } = await newPersonalAccessToken(userId);
  const usedAt = usedMinutesAgo === null ? undefined : Date.now() - usedMinutesAgo * 60_000;
  const state = {
    personalAccessTokens: {
      [keyId]: {
        name: "A script",
        hash,
        email: "person@example.com",
        projects: ["prj_0123"],
        expiresAt: null,
        mintedBy: "issuer-grant",
        mintedAt: new Date().toISOString(),
        endedAt: null,
      },
    },
    endedGrants: {} as AccountState["endedGrants"],
    grantUses: usedAt === undefined ? {} : { [keyId]: { at: usedAt } },
  };
  const appended: unknown[] = [];
  const env = {
    APP_CONFIG_SECRETS__KEY: "secrets-key",
    APP_CONFIG_LOGIN__PASSWORD: "password",
    OAUTH_KV: {
      get: async (key: string) =>
        key === `personal-access-token:${hash}` ? { userId, id: keyId } : null,
    },
    ITERATE_CONTEXT: {
      getByName: () => ({
        invoke: async (path: unknown[]) => {
          const [, surface, verb] = path as [string, string, unknown[]];
          if (surface === "facets") return { offset: appended.length, state };
          if (surface !== "builtins") return undefined;
          appended.push(...verb.slice(1));
          return [{ offset: appended.length }];
        },
      }),
    },
  } as unknown as Env;
  const addresses = platformAddressesOf(env, new Request("https://os.test/api"));
  return {
    env,
    userId,
    keyId,
    usedAt,
    admit: () => authorizationForToken(env, token, addresses, "api"),
    end: (grantId: string) => {
      state.endedGrants[grantId] = { at: new Date().toISOString() };
    },
    appended: () => appended,
  };
}
