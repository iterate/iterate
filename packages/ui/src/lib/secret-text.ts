// What says a form field takes a secret, and where a secret hides in plain text or a URL. The one
// definition behind session replay's masking (components/not-recorded.tsx `posthogPrivacy`) and the
// lint rules that keep secrets out of replays (lint/rules/secret-not-recorded.ts), so the page and
// the lint call the same things secret. Plain TypeScript with no DOM: the lint plugin loads this
// file in Node.

/** Whether a field's id, name, aria-label, placeholder or label names a secret's value:
 *  "wifi-password", "openaiKey", "API key", "Personal access token", "client_secret",
 *  "passwordConfirm", "one-time code". The last word decides, after trailing words that describe
 *  the field rather than what it holds ("value", "input", "confirm"), so a name that only mentions
 *  a secret is not one: "secret-name", "Token name", "password-hint", "keyId", "public-key". */
export function namesSecret(text: string) {
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.join(" ").match(/\b(one time|otp)\b/)) return true;
  while (words.length > 1 && FIELD_WORDS.has(words[words.length - 1])) words.pop();
  return SECRET_WORDS.has(words.at(-1) ?? "") && words.at(-2) !== "public";
}

/** The autocomplete tokens of a field that takes a credential
 *  (https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofilling-form-controls:-the-autocomplete-attribute). */
export const CREDENTIAL_AUTOCOMPLETE = [
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
];

/** The prefixes of well-known API keys and our own personal access tokens (`itk_`,
 *  apps/os/src/personal-access-token.ts): OpenAI and Anthropic, Stripe, GitHub, Slack, AWS, Google
 *  and GitLab. A placeholder such as "sk-proj-…" says its field takes a key. */
export const KEY_PREFIX =
  /\b(?:sk-|(?:sk|rk)_(?:live|test)_|gh[pousr]_|github_pat_|xox[abposr]-|AKIA|AIza|glpat-|itk_)/;

/** `text` with every key it holds (a `KEY_PREFIX` and at least 12 more key characters) replaced by
 *  asterisks of its length: a key pasted into a field that does not say it takes one. */
export function maskKeys(text: string) {
  return text.replace(new RegExp(`${KEY_PREFIX.source}[\\w-]{12,}`, "g"), (key) =>
    "*".repeat(key.length),
  );
}

/** `text` with the secret in each URL path that carries one replaced by its route parameter:
 *  `/invitations/<token>` (the Dash's invitation link, which joins its organization) becomes
 *  `/invitations/:token`, URL-encoded too (`?next=%2Finvitations%2F<token>`, the Dash's step-up
 *  link). A new route whose path holds a secret adds its pattern here. */
export function redactSecretPaths(text: string) {
  return text.replace(/((?:\/|%2F)invitations(?:\/|%2F))[^/?#&"'\s%]+/gi, "$1:token");
}

/** Words that name a secret's value when a name ends in one. Not "tokens": a model's token counts
 *  (`maxTokens`). */
const SECRET_WORDS = new Set([
  "password",
  "passwords",
  "passphrase",
  "passcode",
  "passwd",
  "pwd",
  "secret",
  "secrets",
  "token",
  "key",
  "keys",
  "apikey",
  "privatekey",
  "otp",
  "pat",
  "credential",
  "credentials",
]);

/** Trailing words that describe a field rather than what it holds: "secret-value",
 *  "openai-key-input", "passwordConfirm". */
const FIELD_WORDS = new Set([
  "value",
  "input",
  "field",
  "confirm",
  "confirmation",
  "again",
  "repeat",
]);
