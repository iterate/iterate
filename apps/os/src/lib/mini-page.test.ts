import { expect, test } from "vitest";
import { miniPageReturnUrl } from "./mini-page.ts";

test("a finished mini page returns to the app scheme carrying its outcome", () => {
  expect(miniPageReturnUrl("iterate://mini-page", { status: "saved" })).toBe(
    "iterate://mini-page?status=saved",
  );
  // Expo Go dev clients get the same app under exp://, host and path intact.
  expect(miniPageReturnUrl("exp://192.168.1.4:8081/--/mini-page", { status: "saved" })).toBe(
    "exp://192.168.1.4:8081/--/mini-page?status=saved",
  );
  // Params the caller already put on the deep link survive.
  expect(miniPageReturnUrl("iterate://mini-page?token=abc", { status: "saved" })).toBe(
    "iterate://mini-page?token=abc&status=saved",
  );
});

test("web schemes are never returned to — a mini page is not an open redirect", () => {
  // `returnTo` rides in a link anyone can write, and the page it sits on is
  // behind sign-in: "os.iterate.com sent me to this login form" is exactly
  // the shape phishing wants.
  expect(miniPageReturnUrl("https://evil.example/login", { status: "saved" })).toBeNull();
  expect(miniPageReturnUrl("http://evil.example/login", { status: "saved" })).toBeNull();
  expect(miniPageReturnUrl("javascript:alert(1)", { status: "saved" })).toBeNull();
  expect(miniPageReturnUrl("//evil.example", { status: "saved" })).toBeNull();
  expect(miniPageReturnUrl("not a url", { status: "saved" })).toBeNull();
});

test("an ordinary web visit has nowhere to return to", () => {
  expect(miniPageReturnUrl(undefined, { status: "saved" })).toBeNull();
});
