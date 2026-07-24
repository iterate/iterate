import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthRedirectError } from "./auth-redirect-error.tsx";

test("renders the OAuth callback error from the screenshot", () => {
  const markup = renderToStaticMarkup(
    createElement(AuthRedirectError, {
      error: "Sign_up_is_not_available_for_this_email_address",
      errorDescription: undefined,
    }),
  );

  assert.match(markup, /role="alert"/);
  assert.match(markup, /Sign up is not available for this email address/);
});

test("prefers the provider's error description", () => {
  const markup = renderToStaticMarkup(
    createElement(AuthRedirectError, {
      error: "access_denied",
      errorDescription: "Your administrator denied this sign-in",
    }),
  );

  assert.match(markup, /Your administrator denied this sign-in/);
  assert.doesNotMatch(markup, />Access denied</);
});

test("renders arbitrary redirect errors as text and renders nothing without an error", () => {
  const markup = renderToStaticMarkup(
    createElement(AuthRedirectError, {
      error: "<script>unexpected_error()</script>",
      errorDescription: undefined,
    }),
  );
  const emptyMarkup = renderToStaticMarkup(
    createElement(AuthRedirectError, {
      error: undefined,
      errorDescription: undefined,
    }),
  );

  assert.match(markup, /&lt;script&gt;unexpected error\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(markup, /<script>/);
  assert.equal(emptyMarkup, "");
});
