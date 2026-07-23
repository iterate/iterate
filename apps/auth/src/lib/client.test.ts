import assert from "node:assert/strict";
import { it } from "node:test";
import { createIterateAuthClient } from "./client.ts";

it("starts a Google login that requires account selection", async () => {
  using browser = installBrowserLocation("https://os.iterate.com/sign-in");
  const client = createIterateAuthClient();

  await client.login({
    returnTo: "/projects",
    loginHint: "google",
    prompt: "select_account",
  });

  const loginUrl = new URL(browser.href);
  assert.equal(loginUrl.origin, "https://os.iterate.com");
  assert.equal(loginUrl.pathname, "/api/iterate-auth/login");
  assert.deepEqual(Object.fromEntries(loginUrl.searchParams), {
    return_to: "/projects",
    login_hint: "google",
    prompt: "select_account",
  });
});

function installBrowserLocation(href: string) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const location = { href, origin: new URL(href).origin };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location },
  });

  return {
    get href() {
      return location.href;
    },
    [Symbol.dispose]() {
      if (previousWindow) {
        Object.defineProperty(globalThis, "window", previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    },
  };
}
