// Tests for iterate/secret-field-not-recorded and iterate/secret-shown-not-recorded
// (rules/secret-not-recorded.ts): PostHog's session replay records what people type and see
// (packages/ui not-recorded.tsx `posthogPrivacy`), so a field that takes a secret renders as a
// SecretInput or SecretTextarea, and a secret rendered on the page sits inside a NotRecorded.
// `reports` are the openings of the messages, in source order.

import { expect, test } from "vitest";
import { lintOne } from "./oxlint-fixture.ts";

test.for([
  {
    name: "flags a raw field that says it takes a secret, once per field, naming the evidence",
    rule: "secret-field-not-recorded",
    source: `
      import { Input as TextField } from "@iterate-com/ui/components/input";
      declare const Input: any, Textarea: any, InputGroupInput: any, FieldLabel: any, Label: any;
      declare const show: boolean, keyId: string, register: any;
      export const fields = (
        <form>
          <Input id="wifi-password" type="password" autoComplete="new-password" />
          <input type={"password"} />
          <Input type={show ? "text" : "password"} />
          <Input name="code" autoComplete="one-time-code" />
          <Input id="openai-key" />
          <Input name="clientSecret" />
          <Input id="openaiKey" />
          <Textarea id="secret-value" />
          <InputGroupInput aria-label="Stripe API key" />
          <textarea name="private_key" />
          <Input placeholder="sk-proj-…" />
          <TextField type="password" />
          <input {...register("password")} />
          <Label>Wi-Fi password <Input /></Label>
          <Input id={keyId} />
          <FieldLabel htmlFor={keyId}>API key</FieldLabel>
        </form>
      );
    `,
    reports: [
      '<Input type="password"> takes',
      '<input type="password"> takes',
      '<Input type="password"> takes',
      '<Input autoComplete="one-time-code"> takes',
      '<Input id="openai-key"> takes',
      '<Input name="clientSecret"> takes',
      '<Input id="openaiKey"> takes',
      '<Textarea id="secret-value"> takes',
      '<InputGroupInput aria-label="Stripe API key"> takes',
      '<textarea name="private_key"> takes',
      '<Input placeholder="sk-proj-…"> takes',
      '<TextField type="password"> takes',
      '<input {...register("password")}> takes',
      '<Input labelled "Wi-Fi password"> takes',
      '<Input labelled "API key"> takes',
    ],
  },
  {
    name: "accepts SecretInput, SecretTextarea, a raw field inside NotRecorded, and fields that only mention a secret",
    rule: "secret-field-not-recorded",
    source: `
      declare const Input: any, SecretInput: any, SecretTextarea: any, NotRecorded: any;
      declare const Label: any, FieldLabel: any, kind: string, props: any, nameId: string;
      export const fields = (
        <form>
          <SecretInput id="openai-key" type="password" autoComplete="new-password" />
          <SecretTextarea id="secret-value" />
          <NotRecorded>
            <div><Input readOnly aria-label="API key" /></div>
          </NotRecorded>
          <Input id="secret-name" />
          <Input id="secret-urls" />
          <Input aria-label="Token name" />
          <Input id="password-hint" />
          <Input id="passcode-length" />
          <Input name="maxTokens" type="number" />
          <Input id="keyboard-shortcut" type="text" autoComplete="off" />
          <Input type="email" autoComplete="email" placeholder="Network name (SSID)" />
          <Label>Token name <Input /></Label>
          <Input id={nameId} />
          <FieldLabel htmlFor={nameId}>Secret name</FieldLabel>
          <Input type={kind} {...props} />
        </form>
      );
    `,
    reports: [],
  },
  {
    name: "flags a secret rendered outside NotRecorded: as text, in an element's attribute, in a prop that renders, in a string built for any prop",
    rule: "secret-shown-not-recorded",
    source: `
      declare const Link: any, AllowOrganizations: any, CopyButton: any;
      declare const token: string, minted: { token: string }, apiKey: string, clientSecret: string;
      export const page = (
        <div>
          <code>{minted.token}</code>
          <span>{apiKey.slice(0, 8)}</span>
          <input readOnly value={clientSecret} />
          <a href={\`/invitations/\${token}\`}>join</a>
          <AllowOrganizations next={\`/invitations/\${token}\`} />
          <Link to="/invitations/$token" params={{ token }} />
          <CopyButton value={minted.token} />
        </div>
      );
    `,
    reports: [
      "`minted.token` looks",
      "`apiKey` looks",
      "`clientSecret` looks",
      "`token` looks",
      "`token` looks",
      "`token` looks",
      "`minted.token` looks",
    ],
  },
  {
    name: "accepts a secret inside NotRecorded or a SecretInput, a name that only mentions one, a handler, a key, and a prop that may never render",
    rule: "secret-shown-not-recorded",
    source: `
      declare const NotRecorded: any, SecretInput: any, Button: any, AppProviders: any, Form: any;
      declare const token: string, minted: { token: string; name: string; tokenHash: string };
      declare const apiKey: string, rows: { key: string }[], usage: { tokens: number }, sortedKeys: string[];
      declare const revoke: (token: string) => void, setSecret: () => void, mintPersonalAccessToken: () => void;
      export const page = (
        <div>
          <NotRecorded><code>{minted.token}</code><a href={\`/x/\${token}\`}>x</a></NotRecorded>
          <SecretInput value={apiKey} onChange={() => undefined} />
          <span>{minted.name} {minted.tokenHash}</span>
          <Button onClick={() => revoke(token)}>Revoke</Button>
          <Form onSubmit={mintPersonalAccessToken} action={setSecret} />
          {rows.map((row) => <span key={row.key}>{row.key}</span>)}
          <span>{usage.tokens} {sortedKeys.length}</span>
          {minted && <span>Minted</span>}
          <AppProviders posthogApiKey={apiKey || undefined} />
        </div>
      );
    `,
    reports: [],
  },
])("$name", ({ rule, source, reports }) => {
  const { messages } = lintOne(rule, "input.tsx", source);
  expect(messages).toEqual(reports.map((opening) => expect.stringContaining(opening)));
});
