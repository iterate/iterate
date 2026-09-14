// iterate-context-durable-object.test.ts — the DO's pure half: the secret substitution at the fetch door.

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

// ── the fetch door ── `substituteProjectSecrets` (iterate-context-durable-object.ts), the substitution
// the DO runs before the terminal `fetch`, as a table: `{ url?, headers?, resolve?, becomes }` rows.
// Every `getSecret("/secrets/NAME")` placeholder in the URL (path and query — matched as the URL
// parser spelled it, `"` → %22, `{ ` → %7B%20) and the headers is replaced by its value (`{ field:
// "a.b" }` picks one string out of a JSON value — apps/os's grammar for a URL or a header); a
// placeholder with no stored secret, or a field the value has no string at, refuses, naming the
// placeholder and where it sat; substituted values are never rescanned; a NEW Request only when
// something changed (the rebuild is WS-safe — method, Upgrade and body survive it). `becomes` is
// what the door answered: the rebuilt Request's URL and headers (a subset), "unchanged" (the ORIGINAL
// Request — no rebuild), or `{ refused }` — the `ProjectSecretRefused` message.

const secrets: Record<string, string> = {
  a: "alpha",
  b: "bravo",
  "api.key_v-2": "REAL",
  tg: JSON.stringify({ bot: { token: "123:abc", id: 7 }, plain: "p" }),
};
const rows: {
  name: string;
  url?: string;
  headers?: Record<string, string>;
  resolve?: (name: string) => string | null;
  becomes: { url?: string; headers?: Record<string, string> } | "unchanged" | { refused: string };
}[] = [
  {
    name: "two placeholders in ONE header both substitute — the splice neither swallows nor duplicates text",
    headers: { authorization: 'A=getSecret("/secrets/a") mid B=getSecret("/secrets/b") end' },
    becomes: { headers: { authorization: "A=alpha mid B=bravo end" } },
  },
  {
    name: "a header with no stored secret for its placeholder refuses, naming the placeholder and the header — never the destination",
    headers: { "x-auth": 'Bearer getSecret("/secrets/absent")' },
    becomes: {
      refused:
        'itx.fetch: no stored project secret for getSecret("/secrets/absent") in header "x-auth"',
    },
  },
  {
    name: "no placeholder anywhere returns the ORIGINAL request untouched (no needless Request rebuild)",
    headers: { authorization: "Bearer plain", "x-note": "getSecret is a word, not a call" },
    becomes: "unchanged",
  },
  {
    name: "substitution never rescans substituted VALUES (no placeholder injection through a secret)",
    headers: { "x-auth": 'getSecret("/secrets/outer")' },
    resolve: (name) => (name === "outer" ? 'getSecret("/secrets/inner")' : "INNER-LEAKED"),
    becomes: { headers: { "x-auth": 'getSecret("/secrets/inner")' } }, // literal, not re-resolved
  },
  {
    name: "the grammar: the whole secret-name charset [a-zA-Z0-9._-], whitespace inside the parentheses, and only the `/secrets/` path",
    headers: {
      authorization: 'Bearer getSecret( "/secrets/api.key_v-2" )',
      "x-other": 'getSecret("/config/a")', // not a secret path: left as written
    },
    becomes: { headers: { authorization: "Bearer REAL", "x-other": 'getSecret("/config/a")' } },
  },
  {
    name: "`{ field }` picks one string out of a JSON value by its dotted path — spaced and compact",
    headers: {
      authorization: 'Bearer getSecret("/secrets/tg", { field: "bot.token" })',
      "x-compact": 'getSecret("/secrets/tg",{field:"plain"})',
    },
    becomes: { headers: { authorization: "Bearer 123:abc", "x-compact": "p" } },
  },
  {
    name: "`{ field }` at a path the JSON value has no string at refuses, naming the placeholder and where it sat",
    headers: { "x-auth": 'getSecret("/secrets/tg", { field: "bot.nope" })' },
    becomes: {
      refused:
        'itx.fetch: getSecret("/secrets/tg", { field: "bot.nope" }) in header "x-auth": the secret has no string at field "bot.nope"',
    },
  },
  {
    name: "`{ field }` at a non-string leaf refuses",
    headers: { "x-auth": 'getSecret("/secrets/tg", { field: "bot.id" })' },
    becomes: {
      refused:
        'itx.fetch: getSecret("/secrets/tg", { field: "bot.id" }) in header "x-auth": the secret has no string at field "bot.id"',
    },
  },
  {
    name: "`{ field }` on a non-JSON value refuses",
    headers: { "x-auth": 'getSecret("/secrets/a", { field: "x" })' },
    becomes: {
      refused:
        'itx.fetch: getSecret("/secrets/a", { field: "x" }) in header "x-auth" names a field, but the secret is not a JSON value',
    },
  },
  {
    // `?access_token=getSecret("/secrets/token")` is a common shape; a header-only substituter would
    // forward the credential's NAME to the destination
    name: "a secret in the URL query is substituted as ONE component — the NAME never leaves, and a value cannot add a parameter or a fragment",
    url: 'https://api.example.com/data?access_token=getSecret("/secrets/a")',
    resolve: () => "v&role=admin#frag",
    becomes: { url: "https://api.example.com/data?access_token=v%26role%3Dadmin%23frag" },
  },
  {
    name: "a secret in the URL PATH (the parser spelled it `getSecret(%22/secrets/a%22)`) is substituted too",
    url: 'https://api.example.com/token/getSecret("/secrets/a")/x',
    becomes: { url: "https://api.example.com/token/alpha/x" },
  },
  {
    name: "the `{ field }` form in the URL PATH (`%7B%20field:%20%22bot.token%22%20%7D`), `:` kept — a Telegram bot token",
    url: 'https://api.example.com/bot/getSecret("/secrets/tg", { field: "bot.token" })/send',
    becomes: { url: "https://api.example.com/bot/123:abc/send" },
  },
  {
    name: "a URL placeholder with no stored secret refuses naming the request URL",
    url: 'https://api.example.com/?t=getSecret("/secrets/absent")',
    becomes: {
      refused:
        'itx.fetch: no stored project secret for getSecret("/secrets/absent") in the request URL',
    },
  },
];

for (const row of rows)
  test(row.name, async () => {
    const request = new Request(row.url || "https://api.example.com/", { headers: row.headers });
    const became = await substituteProjectSecrets(
      request,
      row.resolve || ((name) => secrets[name] ?? null),
    ).then(
      (out) =>
        out === request ? "unchanged" : { url: out.url, headers: Object.fromEntries(out.headers) },
      (error: unknown) =>
        error instanceof ProjectSecretRefused ? { refused: error.message } : Promise.reject(error),
    );
    if (typeof row.becomes === "string") expect(became).toBe(row.becomes);
    else expect(became).toMatchObject(row.becomes);
  });
