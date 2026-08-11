import { expect, test } from "vitest";
import {
  recommendationMismatches,
  recommendationSwitchPlan,
  validatedTestEmail,
} from "./expected-backend.ts";

const preview14 = { baseUrl: "https://os.iterate-preview-14.com", label: "preview 14" };
const prd = "https://os.iterate.com";

test("everything matching yields no mismatches and no plan", () => {
  const phone = {
    serverBaseUrl: preview14.baseUrl,
    email: "pr2462+test@nustom.com",
    recommendedServerEmail: "pr2462+test@nustom.com",
  };
  const qr = { server: preview14, email: "PR2462+test@nustom.com" }; // case-insensitive
  expect(recommendationMismatches(phone, qr)).toEqual([]);
  expect(recommendationSwitchPlan(phone, qr)).toBeNull();
});

test("backend differs, already signed in on the recommended server: pure repoint", () => {
  const phone = {
    serverBaseUrl: prd,
    email: "misha@example.com",
    recommendedServerEmail: "pr2462+test@nustom.com",
  };
  const qr = { server: preview14, email: "pr2462+test@nustom.com" };
  // Identity is compared against where the switch LANDS, not where the phone is.
  expect(recommendationMismatches(phone, qr)).toEqual([
    { kind: "backend", current: prd, recommended: preview14 },
  ]);
  expect(recommendationSwitchPlan(phone, qr)).toEqual({
    type: "use-server",
    baseUrl: preview14.baseUrl,
    label: "preview 14",
  });
});

test("backend differs, signed out (or wrong identity) there: one sign-in fixes both", () => {
  const signedOut = {
    serverBaseUrl: prd,
    email: "misha@example.com",
    recommendedServerEmail: null,
  };
  const qr = { server: preview14, email: "pr2462+test@nustom.com" };
  expect(recommendationMismatches(signedOut, qr)).toEqual([
    { kind: "backend", current: prd, recommended: preview14 },
    { kind: "identity", current: null, recommended: "pr2462+test@nustom.com" },
  ]);
  const plan = {
    type: "sign-in",
    baseUrl: preview14.baseUrl,
    label: "preview 14",
    loginHint: "pr2462+test@nustom.com",
  };
  expect(recommendationSwitchPlan(signedOut, qr)).toEqual(plan);
  expect(
    recommendationSwitchPlan({ ...signedOut, recommendedServerEmail: "someone@else.com" }, qr),
  ).toEqual(plan);
});

test("backend differs with no identity hint: repoint when signed in there, sign in when not", () => {
  const qr = { server: preview14, email: null };
  expect(
    recommendationSwitchPlan(
      { serverBaseUrl: prd, email: null, recommendedServerEmail: "misha@example.com" },
      qr,
    ),
  ).toEqual({ type: "use-server", baseUrl: preview14.baseUrl, label: "preview 14" });
  expect(
    recommendationSwitchPlan({ serverBaseUrl: prd, email: null, recommendedServerEmail: null }, qr),
  ).toEqual({ type: "sign-in", baseUrl: preview14.baseUrl, label: "preview 14", loginHint: null });
});

test("backend matches but the identity differs: sign in as the test identity, same server", () => {
  const phone = {
    serverBaseUrl: preview14.baseUrl,
    email: "misha@example.com",
    recommendedServerEmail: "misha@example.com",
  };
  const qr = { server: preview14, email: "pr2462+test@nustom.com" };
  expect(recommendationMismatches(phone, qr)).toEqual([
    { kind: "identity", current: "misha@example.com", recommended: "pr2462+test@nustom.com" },
  ]);
  expect(recommendationSwitchPlan(phone, qr)).toEqual({
    type: "sign-in",
    baseUrl: preview14.baseUrl,
    label: "preview 14",
    loginHint: "pr2462+test@nustom.com",
  });
});

test("no recommended server: nothing to compare, even with an email hint", () => {
  // Without an expected env we don't know which deployment's test OTP the
  // identity rides — mirrors the sign-in screen's refusal to login_hint
  // anywhere else.
  const phone = { serverBaseUrl: prd, email: null, recommendedServerEmail: null };
  const qr = { server: null, email: "pr2462+test@nustom.com" };
  expect(recommendationMismatches(phone, qr)).toEqual([]);
  expect(recommendationSwitchPlan(phone, qr)).toBeNull();
});

test("only per-PR test addresses survive validation", () => {
  expect(validatedTestEmail("pr2462+test@nustom.com")).toBe("pr2462+test@nustom.com");
  expect(validatedTestEmail("misha@example.com")).toBeNull();
  expect(validatedTestEmail("pr2462+test@evil.com")).toBeNull();
  expect(validatedTestEmail(undefined)).toBeNull();
  expect(validatedTestEmail(42)).toBeNull();
});
