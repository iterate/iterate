// What session replay's masking and the lint rules call secret (secret-text.ts). The names are what
// fields in this repository and common libraries use; the negatives only mention a secret.
import { expect, test } from "vitest";
import { KEY_PREFIX, maskKeys, namesSecret, redactSecretPaths } from "./secret-text.ts";

test.for([
  { text: "wifi-password", secret: true },
  { text: "current-password", secret: true },
  { text: "passwordConfirm", secret: true },
  { text: "openaiKey", secret: true },
  { text: "openai-key-input", secret: true },
  { text: "API key", secret: true },
  { text: "Stripe API key", secret: true },
  { text: "api-keys", secret: true },
  { text: "apiToken", secret: true },
  { text: "Personal access token", secret: true },
  { text: "client_secret", secret: true },
  { text: "webhookSecret", secret: true },
  { text: "secret-value", secret: true },
  { text: "private_key", secret: true },
  { text: "one-time code", secret: true },
  { text: "otp-code", secret: true },
  { text: "pat", secret: true },
  { text: "secret-name", secret: false },
  { text: "Token name", secret: false },
  { text: "token-name", secret: false },
  { text: "password-hint", secret: false },
  { text: "passcode-length", secret: false },
  { text: "keyId", secret: false },
  { text: "key-name", secret: false },
  { text: "public-key", secret: false },
  { text: "keyboard-shortcut", secret: false },
  { text: "maxTokens", secret: false },
  { text: "Value", secret: false },
  { text: "Network name (SSID)", secret: false },
  { text: "", secret: false },
])("namesSecret($text) is $secret", ({ text, secret }) => {
  expect(namesSecret(text)).toBe(secret);
});

test("a key's prefix marks a placeholder, and a key in any text is masked to its length", () => {
  expect(
    ["sk-proj-…", "ghp_…", "itk_…", "xoxb-…", "AKIA…"].map((text) => KEY_PREFIX.test(text)),
  ).toEqual([true, true, true, true, true]);
  expect(["Network name", "task-list", "ask-me"].map((text) => KEY_PREFIX.test(text))).toEqual([
    false,
    false,
    false,
  ]);
  expect(maskKeys("use sk-FAKE-abcdefghijklmnop for now")).toBe(
    `use ${"*".repeat("sk-FAKE-abcdefghijklmnop".length)} for now`,
  );
  expect(maskKeys("ask-me about sk-short")).toBe("ask-me about sk-short");
});

test("an invitation link's token is redacted wherever the path appears", () => {
  expect(
    [
      "https://dash.iterate.com/invitations/FAKE-invite-token",
      "/invitations/FAKE-invite-token?x=1#y",
      "/.auth/login?next=/invitations/FAKE-invite-token&scope=a",
      "/.auth/login?next=%2Finvitations%2FFAKE-invite-token&scope=a",
      "/organizations/org_1",
    ].map(redactSecretPaths),
  ).toEqual([
    "https://dash.iterate.com/invitations/:token",
    "/invitations/:token?x=1#y",
    "/.auth/login?next=/invitations/:token&scope=a",
    "/.auth/login?next=%2Finvitations%2F:token&scope=a",
    "/organizations/org_1",
  ]);
});
