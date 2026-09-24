// A sign-in whose last step fails on the platform's side (src/issuer-session.ts): the code exchange
// against the issuer's own /oauth2/token, which the browser session bounds at 10 s. The person is
// sent back to the sign-in page with the error, and the failure is logged as a platform failure.
import { exports } from "cloudflare:workers";
import { expect, onTestFinished, test, vi } from "vitest";
import { clearLoginCookie } from "../src/password-and-code-sign-in.ts";
import { loginPassword, ORIGIN } from "./support.ts";

test("a code exchange that times out sends the person back to the sign-in page with the error, logged as a platform failure", async () => {
  const fetches = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== ORIGIN) throw new Error(`Unexpected external fetch: ${url}`);
    // what `AbortSignal.timeout(10_000)` rejects the exchange with, without the ten seconds
    if (url.pathname === "/oauth2/token")
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    return exports.default.fetch(request);
  });
  const warn = vi.spyOn(console, "warn");
  onTestFinished(() => {
    fetches.mockRestore();
    warn.mockRestore();
  });

  const response = await exports.default.fetch(
    new Request(`${ORIGIN}/login`, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({
        email: "slow-exchange@example.com",
        password: loginPassword(),
        next: "/login",
      }),
    }),
  );

  expect(response).toMatchObject({ status: 303 });
  // no issuer session: only the pending code's cookie, dropped
  expect(response.headers.getSetCookie()).toEqual([clearLoginCookie]);
  const back = new URL(response.headers.get("location")!, ORIGIN);
  expect(back).toMatchObject({ pathname: "/login" });
  expect(Object.fromEntries(back.searchParams)).toEqual({
    next: "/login",
    error: "Sign-in failed on our side. Try again.",
    email: "slow-exchange@example.com",
    method: "password",
  });
  expect(warn).toHaveBeenCalledWith({
    event: "issuer.platform-failure-sign-in",
    name: "code-exchange",
    message: "The operation was aborted due to timeout",
    waitedMs: expect.any(Number),
  });
});
