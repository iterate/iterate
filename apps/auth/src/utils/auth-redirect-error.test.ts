import assert from "node:assert/strict";
import { test } from "node:test";
import { getLoginRedirectSearch } from "./auth-redirect-error.ts";

test("moves a protected-page auth error onto login and removes it from the post-login destination", () => {
  assert.deepEqual(
    getLoginRedirectSearch(
      "/?error=Sign_up_is_not_available_for_this_email_address&error_description=Use%20another%20account",
    ),
    {
      redirect: "/",
      error: "Sign_up_is_not_available_for_this_email_address",
      error_description: "Use another account",
    },
  );
});

test("preserves unrelated destination state when removing handled auth errors", () => {
  assert.deepEqual(
    getLoginRedirectSearch("/projects/example?tab=settings&error=access_denied#members"),
    {
      redirect: "/projects/example?tab=settings#members",
      error: "access_denied",
    },
  );
});

test("leaves ordinary protected-page redirects unchanged", () => {
  assert.deepEqual(getLoginRedirectSearch("/projects/example?tab=settings#members"), {
    redirect: "/projects/example?tab=settings#members",
  });
});
