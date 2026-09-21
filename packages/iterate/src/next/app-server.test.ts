// app-server.test.ts — the browser-auth gate's `/.auth/login` with a session the platform still
// honours: through to `next` when the sign-in covers what the page asked for, else the "Sign in
// again" page (a project the page named, or a permission the app asks for), which names who the app
// is signed in as and the permissions the grant holds, and whose one button is a same-origin POST
// that ends this app's session and returns to the very same login URL. The page's "signed in as /
// reaches" read of the platform is best effort: here `resource` is an offline loopback, so those two
// lines are absent and the network-free permissions line (from the held scopes) is what we assert.
import { describe, expect, test } from "vitest";
import { appAuth } from "./app-server.ts";

const ISSUER = "https://os.example";

/** One app session the platform honours, holding `scopes`; the platform read is pointed at a closed
 *  port so it fails at once and the page degrades. */
function login(path: string, scopes: string[]) {
  const sessions = {
    getByName: () => ({ bearer: async () => "token", scopes: async () => scopes }),
  } as unknown as DurableObjectNamespace<never>;
  return appAuth(
    new Request(`https://notes.example${path}`, {
      headers: { cookie: "__Host-itx-session=0c9a1c4e-7d2b-4d7e-9a4a-1f3c5e7b9d21" },
    }),
    { sessions, issuer: ISSUER, resource: "http://127.0.0.1:1/api", api: () => new Response("") },
  );
}

describe("/.auth/login with a session the platform honours", () => {
  test("covers what the page asked for → straight to next", async () => {
    const response = await login("/.auth/login?next=%2Fprojects%2Facme&scope=iterate", ["iterate"]);
    expect(response?.status).toBe(303);
    expect(response?.headers.get("location")).toBe("/projects/acme");
  });

  test.each([
    {
      lacks: "a project the page named",
      path: "/.auth/login?next=%2Fprojects%2Facme&scope=iterate&project=acme",
      says: "does not include a project called <code>acme</code>",
    },
    {
      lacks: "a permission the app asks for",
      path: "/.auth/login?next=%2F&scope=iterate%20account",
      says: "does not include a permission this app asks for",
    },
  ])("$lacks → the Sign in again page", async ({ path, says }) => {
    const response = await login(path, ["iterate"]);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    const html = await response!.text();
    expect(html).toContain("<h1>Sign in again</h1>");
    expect(html).toContain(`Your sign-in to <strong>notes.example</strong> ${says}.`);
    expect(html).toContain(`href="${ISSUER}/issuer.css"`);
    // the grant it holds, in the person's words — network-free, from the held scopes
    expect(html).toContain("Permissions: your projects.");
    // the button ends this app's session and comes back to this same login URL
    expect(html).toContain(`action="/.auth/logout?next=${encodeURIComponent(path)}"`);
  });

  test("the permissions line names every held scope", async () => {
    const response = await login("/.auth/login?next=%2F&project=acme", [
      "iterate",
      "account",
      "organizations:write",
    ]);
    const html = await response!.text();
    expect(html).toContain("Permissions: your projects, your account, your organizations.");
  });

  test("the project the page named is text, never markup", async () => {
    const response = await login(
      `/.auth/login?next=%2F&project=${encodeURIComponent("<b>x</b>")}`,
      ["iterate"],
    );
    const html = await response!.text();
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&#60;b&#62;x&#60;/b&#62;");
  });
});
