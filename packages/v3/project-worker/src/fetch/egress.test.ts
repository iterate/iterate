// fetch/egress.test.ts — `substituteProjectSecrets` (fetch/egress.ts), the substitution the DO's
// egress terminal runs before `fetch`: every `{{secret:project:NAME}}` token in the URL and the
// headers is replaced by its value; a token with no stored secret throws, naming the token and where
// it sat; substituted values are never rescanned; a NEW Request only when something changed (the
// rebuild is WS-safe — method, Upgrade and body survive it).
import { expect, test } from "vitest";
import { ProjectSecretRefused, substituteProjectSecrets } from "./egress.ts";

const secrets: Record<string, string> = { a: "alpha", b: "bravo", "api.key_v-2": "REAL" };
const resolve = (name: string) => secrets[name] ?? null;

test("two tokens in ONE header both substitute — the splice neither swallows nor duplicates text", async () => {
  const request = new Request("https://api.example.com/", {
    headers: { authorization: "A={{secret:project:a}} mid B={{secret:project:b}} end" },
  });
  const out = await substituteProjectSecrets(request, resolve);
  expect(out.headers.get("authorization")).toBe("A=alpha mid B=bravo end");
  expect(out).not.toBe(request); // something changed → a NEW request
});

test("a header with no stored secret for its token throws, naming the token and the header — never the destination", async () => {
  const request = new Request("https://api.example.com/", {
    headers: { "x-auth": "Bearer {{secret:project:absent}}" },
  });
  const failure = await substituteProjectSecrets(request, resolve).catch((error) => error);
  expect(failure).toBeInstanceOf(ProjectSecretRefused);
  expect(failure.message).toBe(
    'egress: no stored project secret for {{secret:project:absent}} in header "x-auth"',
  );
});

test("no token anywhere returns the ORIGINAL request untouched (no needless Request rebuild)", async () => {
  const request = new Request("https://api.example.com/?q={{not:a:secret}}", {
    headers: { "x-auth": "plain" },
  });
  expect(await substituteProjectSecrets(request, resolve)).toBe(request);
});

test("substitution never rescans substituted VALUES (no token injection through a secret)", async () => {
  const request = new Request("https://api.example.com/", {
    headers: { "x-auth": "{{secret:project:outer}}" },
  });
  const out = await substituteProjectSecrets(request, (name) =>
    name === "outer" ? "{{secret:project:inner}}" : "INNER-LEAKED",
  );
  expect(out.headers.get("x-auth")).toBe("{{secret:project:inner}}"); // literal, not re-resolved
});

test("the token grammar reads the whole secret-name charset [a-zA-Z0-9._-]", async () => {
  const request = new Request("https://api.example.com/", {
    headers: { authorization: "Bearer {{secret:project:api.key_v-2}}" },
  });
  const out = await substituteProjectSecrets(request, resolve);
  expect(out.headers.get("authorization")).toBe("Bearer REAL");
});

test("a secret in the URL query is substituted as ONE component — the NAME never leaves, and a value cannot add a parameter or a fragment", async () => {
  // `?access_token={{secret:project:token}}` is a common shape; a header-only substituter would
  // send the placeholder (the name) to the destination and the value nowhere.
  const request = new Request("https://api.example.com/data?access_token={{secret:project:a}}");
  const out = await substituteProjectSecrets(request, () => "v&role=admin#frag");
  expect(out.url).toBe("https://api.example.com/data?access_token=v%26role%3Dadmin%23frag");
  expect(new URL(out.url).searchParams.get("access_token")).toBe("v&role=admin#frag");
});

test("a secret in the URL PATH (percent-encoded by the URL parser) is substituted too", async () => {
  const request = new Request("https://api.example.com/token/{{secret:project:a}}/x");
  expect(request.url).toContain("%7B%7Bsecret:project:a%7D%7D"); // what the parser did to it
  expect((await substituteProjectSecrets(request, resolve)).url).toBe(
    "https://api.example.com/token/alpha/x",
  );
});

test("a URL token with no stored secret throws naming the request URL", async () => {
  const request = new Request("https://api.example.com/?t={{secret:project:absent}}");
  const failure = await substituteProjectSecrets(request, resolve).catch((error) => error);
  expect(failure).toBeInstanceOf(ProjectSecretRefused);
  expect(failure.message).toBe(
    "egress: no stored project secret for {{secret:project:absent}} in the request URL",
  );
});
