import { expect, test } from "vitest";
import { loginSearchOf } from "./login-search.ts";

test("the sign-in search survives the router's null-prototype parse", () => {
  const parsed = Object.assign(Object.create(null), { next: "/oauth2/auth?client_id=x", email: 1 });
  expect(loginSearchOf(parsed)).toEqual({
    next: "/oauth2/auth?client_id=x",
    error: undefined,
    email: undefined,
    method: undefined,
  });
});
