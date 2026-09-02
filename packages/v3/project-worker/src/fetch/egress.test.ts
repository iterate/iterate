// fetch/egress.test.ts — `substituteHeaderSecrets` (@v3/shared/egress), the substitution the DO's
// egress terminal runs before FALLBACK: every `{{secret:<scope>:NAME}}` token of THIS door's scope
// in the URL and the headers is replaced by its value; other scopes and unresolved names are left
// intact for the next door down; substituted values are never rescanned; a NEW Request only when
// something changed (the rebuild is WS-safe — method, Upgrade and body survive it).
import { expect, test } from "vitest";
import { substituteHeaderSecrets } from "@v3/shared/egress";

test("resolved, missing, and other-scope tokens in ONE header substitute exactly the resolvable ones", async () => {
  // The splice arithmetic: an unresolved token BETWEEN two resolved ones survives with the
  // surrounding substitutions intact (the cursor neither swallows nor duplicates text).
  const request = new Request("https://api.example.com/", {
    headers: {
      authorization:
        "A={{secret:project:a}} M={{secret:project:missing}} B={{secret:project:b}} P={{secret:platform:infra}}",
    },
  });
  const out = await substituteHeaderSecrets(request, "project", (name) =>
    name === "a" ? "alpha" : name === "b" ? "bravo" : null,
  );
  expect(out.headers.get("authorization")).toBe(
    "A=alpha M={{secret:project:missing}} B=bravo P={{secret:platform:infra}}",
  );
  expect(out).not.toBe(request); // something changed → a NEW request
});

test("a header with only other-scope or unresolved tokens returns the ORIGINAL request untouched", async () => {
  // A missing project token is left intact for the next door down — the contract of a chain door.
  const request = new Request("https://api.example.com/", {
    headers: { "x-auth": "{{secret:platform:infra}} {{secret:project:absent}}" },
  });
  const out = await substituteHeaderSecrets(request, "project", () => null);
  expect(out).toBe(request); // unchanged → same object (no needless Request rebuild)
  expect(out.headers.get("x-auth")).toBe("{{secret:platform:infra}} {{secret:project:absent}}");
});

test("substitution never rescans substituted VALUES (no token injection through a secret)", async () => {
  const request = new Request("https://api.example.com/", {
    headers: { "x-auth": "{{secret:project:outer}}" },
  });
  const out = await substituteHeaderSecrets(request, "project", (name) =>
    name === "outer" ? "{{secret:project:inner}}" : "INNER-LEAKED",
  );
  expect(out.headers.get("x-auth")).toBe("{{secret:project:inner}}"); // literal, not re-resolved
});

test("the token grammar reads the whole secret-name charset [a-zA-Z0-9._-]", async () => {
  const request = new Request("https://api.example.com/", {
    headers: { authorization: "Bearer {{secret:project:api.key_v-2}}" },
  });
  const out = await substituteHeaderSecrets(request, "project", (name) =>
    name === "api.key_v-2" ? "REAL" : null,
  );
  expect(out.headers.get("authorization")).toBe("Bearer REAL");
});

test("a project secret spelled in the URL is substituted too — the credential's NAME never leaves, its value does", async () => {
  // `?access_token={{secret:project:token}}` is a common shape; a header-only substituter would
  // send the placeholder (the name) to the destination and the value nowhere.
  const request = new Request("https://api.example.com/data?access_token={{secret:project:token}}");
  const out = await substituteHeaderSecrets(request, "project", (name) =>
    name === "token" ? "REAL" : null,
  );
  expect(out.url).not.toContain("{{secret:project:");
  expect(out.url).toContain("REAL");
});
