// iterate-context-durable-object.test.ts — the DO's pure half: the egress secret substitution.

import { expect, test, vi } from "vitest";

// The module under test reaches classes from "cloudflare:workers" (RpcTarget, DurableObject,
// WorkerEntrypoint, the pipelining brands), which node cannot resolve — mock JUST those base classes
// (no-op shells); the module's own logic runs unmodified.
vi.mock("cloudflare:workers", () => ({
  RpcTarget: class {},
  DurableObject: class {},
  WorkerEntrypoint: class {},
  RpcPromise: class {},
  RpcProperty: class {},
}));
import {
  ProjectSecretRefused,
  substituteProjectSecrets,
} from "./iterate-context-durable-object.ts";

// ── egress ── `substituteProjectSecrets` (iterate-context-durable-object.ts), the substitution the DO's
// egress terminal runs before `fetch`: every `getSecret("/secrets/NAME")` placeholder in the URL and
// the headers is replaced by its value (`{ field: "a.b" }` picks one string out of a JSON value — apps/os's
// grammar); a placeholder with no stored secret, or a field the value has no string at, throws, naming
// the placeholder and where it sat; substituted values are never rescanned; a NEW Request only when
// something changed (the rebuild is WS-safe — method, Upgrade and body survive it).

const secrets: Record<string, string> = {
  a: "alpha",
  b: "bravo",
  "api.key_v-2": "REAL",
  tg: JSON.stringify({ bot: { token: "123:abc", id: 7 }, plain: "p" }),
};
const resolve = (name: string) => secrets[name] ?? null;

test("two placeholders in ONE header both substitute — the splice neither swallows nor duplicates text", async () => {
  const request = new Request("https://api.example.com/", {
    headers: { authorization: 'A=getSecret("/secrets/a") mid B=getSecret("/secrets/b") end' },
  });
  const out = await substituteProjectSecrets(request, resolve);
  expect(out.headers.get("authorization")).toBe("A=alpha mid B=bravo end");
  expect(out).not.toBe(request);
});

test("a header with no stored secret for its placeholder throws, naming the placeholder and the header — never the destination", async () => {
  const request = new Request("https://api.example.com/", {
    headers: { "x-auth": 'Bearer getSecret("/secrets/absent")' },
  });
  const failure = await substituteProjectSecrets(request, resolve).catch((error) => error);
  expect(failure).toBeInstanceOf(ProjectSecretRefused);
  expect((failure as Error).message).toBe(
    'egress: no stored project secret for getSecret("/secrets/absent") in header "x-auth"',
  );
});

test("no placeholder anywhere returns the ORIGINAL request untouched (no needless Request rebuild)", async () => {
  const request = new Request("https://api.example.com/", {
    headers: { authorization: "Bearer plain", "x-note": "getSecret is a word, not a call" },
  });
  expect(await substituteProjectSecrets(request, resolve)).toBe(request);
});

test("substitution never rescans substituted VALUES (no placeholder injection through a secret)", async () => {
  const request = new Request("https://api.example.com/", {
    headers: { "x-auth": 'getSecret("/secrets/outer")' },
  });
  const out = await substituteProjectSecrets(request, (name) =>
    name === "outer" ? 'getSecret("/secrets/inner")' : "INNER-LEAKED",
  );
  expect(out.headers.get("x-auth")).toBe('getSecret("/secrets/inner")'); // literal, not re-resolved
});

test("the grammar: the whole secret-name charset [a-zA-Z0-9._-], whitespace inside the parentheses, and only the `/secrets/` path", async () => {
  const request = new Request("https://api.example.com/", {
    headers: {
      authorization: 'Bearer getSecret( "/secrets/api.key_v-2" )',
      "x-other": 'getSecret("/config/a")', // not a secret path: left as written
    },
  });
  const out = await substituteProjectSecrets(request, resolve);
  expect(out.headers.get("authorization")).toBe("Bearer REAL");
  expect(out.headers.get("x-other")).toBe('getSecret("/config/a")');
});

test("`{ field }` picks one string out of a JSON value by its dotted path; a missing field, a non-string leaf and a non-JSON value each refuse, naming the placeholder and where it sat", async () => {
  const out = await substituteProjectSecrets(
    new Request("https://api.example.com/", {
      headers: {
        authorization: 'Bearer getSecret("/secrets/tg", { field: "bot.token" })',
        "x-compact": 'getSecret("/secrets/tg",{field:"plain"})',
      },
    }),
    resolve,
  );
  expect(out.headers.get("authorization")).toBe("Bearer 123:abc");
  expect(out.headers.get("x-compact")).toBe("p");
  const refusal = (header: string): Promise<string> =>
    substituteProjectSecrets(
      new Request("https://api.example.com/", { headers: { "x-auth": header } }),
      resolve,
    ).then(
      () => "resolved",
      (error: Error) => error.message,
    );
  expect(await refusal('getSecret("/secrets/tg", { field: "bot.nope" })')).toBe(
    'egress: getSecret("/secrets/tg", { field: "bot.nope" }) in header "x-auth": the secret has no string at field "bot.nope"',
  );
  expect(await refusal('getSecret("/secrets/tg", { field: "bot.id" })')).toContain(
    'no string at field "bot.id"',
  );
  expect(await refusal('getSecret("/secrets/a", { field: "x" })')).toBe(
    'egress: getSecret("/secrets/a", { field: "x" }) in header "x-auth" names a field, but the secret is not a JSON value',
  );
});

test("a secret in the URL query is substituted as ONE component — the NAME never leaves, and a value cannot add a parameter or a fragment", async () => {
  // `?access_token=getSecret("/secrets/token")` is a common shape; a header-only substituter would
  // forward the credential's NAME to the destination.
  const request = new Request('https://api.example.com/data?access_token=getSecret("/secrets/a")');
  const out = await substituteProjectSecrets(request, () => "v&role=admin#frag");
  expect(out.url).toBe("https://api.example.com/data?access_token=v%26role%3Dadmin%23frag");
  expect(new URL(out.url).searchParams.get("access_token")).toBe("v&role=admin#frag");
});

test("a secret in the URL PATH (percent-encoded by the URL parser) is substituted too — the plain and the `{ field }` form", async () => {
  const request = new Request('https://api.example.com/token/getSecret("/secrets/a")/x');
  expect(request.url).toContain("getSecret(%22/secrets/a%22)"); // what the parser did to it
  expect((await substituteProjectSecrets(request, resolve)).url).toBe(
    "https://api.example.com/token/alpha/x",
  );
  const bot = new Request(
    'https://api.example.com/bot/getSecret("/secrets/tg", { field: "bot.token" })/send',
  );
  expect(bot.url).toContain("%7B%20field:%20%22bot.token%22%20%7D");
  expect((await substituteProjectSecrets(bot, resolve)).url).toBe(
    "https://api.example.com/bot/123%3Aabc/send",
  );
});

test("a URL placeholder with no stored secret throws naming the request URL", async () => {
  const request = new Request('https://api.example.com/?t=getSecret("/secrets/absent")');
  const failure = await substituteProjectSecrets(request, resolve).catch((error) => error);
  expect(failure).toBeInstanceOf(ProjectSecretRefused);
  expect((failure as Error).message).toBe(
    'egress: no stored project secret for getSecret("/secrets/absent") in the request URL',
  );
});
