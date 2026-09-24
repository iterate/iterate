// Tests for iterate/secret-field-not-recorded: PostHog's session replay records what people type
// into a field (packages/ui not-recorded.tsx `sessionRecordingPrivacy`), so a field that takes a
// secret renders as a SecretInput or SecretTextarea, which replay and autocapture leave out, or
// inside a NotRecorded. The rule flags a raw field that says it takes one.

import { expect, test } from "vitest";
import { createOxlintFixture } from "./oxlint-fixture.ts";

test("flags a raw field that says it takes a secret, once per field, naming the evidence", () => {
  using fixture = createOxlintFixture({ rules: { "iterate/secret-field-not-recorded": "error" } });
  fixture.write(
    "secret-fields.tsx",
    [
      "declare const Input: any, Textarea: any, InputGroupInput: any;",
      "export const fields = (",
      "  <form>",
      '    <Input id="wifi-password" type="password" autoComplete="new-password" />',
      '    <input type={"password"} />',
      '    <Input name="code" autoComplete="one-time-code" />',
      '    <Input id="openai-key" />',
      '    <Textarea id="secret-value" />',
      '    <InputGroupInput aria-label="Stripe API key" />',
      '    <textarea name="private_key" />',
      '    <Input id="github-token" />',
      "  </form>",
      ");",
      "",
    ].join("\n"),
  );

  expect(
    fixture
      .diagnostics(["secret-fields.tsx"])
      .map((diagnostic) => diagnostic.message.split(">")[0]),
  ).toEqual([
    '<Input type="password"',
    '<input type="password"',
    '<Input autoComplete="one-time-code"',
    '<Input id="openai-key"',
    '<Textarea id="secret-value"',
    '<InputGroupInput aria-label="Stripe API key"',
    '<textarea name="private_key"',
    '<Input id="github-token"',
  ]);
});

test("accepts SecretInput, SecretTextarea, a raw field inside NotRecorded, and fields that only mention a secret", () => {
  using fixture = createOxlintFixture({ rules: { "iterate/secret-field-not-recorded": "error" } });
  fixture.write(
    "not-secret.tsx",
    [
      "declare const Input: any, SecretInput: any, SecretTextarea: any, NotRecorded: any;",
      "declare const kind: string, props: any;",
      "export const fields = (",
      "  <form>",
      '    <SecretInput id="openai-key" type="password" autoComplete="new-password" />',
      '    <SecretTextarea id="secret-value" />',
      "    <NotRecorded>",
      '      <div><Input readOnly aria-label="API key" /></div>',
      "    </NotRecorded>",
      '    <Input id="secret-name" />',
      '    <Input id="secret-urls" />',
      '    <Input aria-label="Token name" />',
      '    <Input id="keyboard-shortcut" type="text" autoComplete="off" />',
      '    <Input type="email" autoComplete="email" />',
      "    <Input type={kind} {...props} />",
      "  </form>",
      ");",
      "",
    ].join("\n"),
  );

  fixture.run(["not-secret.tsx"]);
});
