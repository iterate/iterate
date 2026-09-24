// @vitest-environment jsdom
// What PostHog would receive from a page, with the apps' own options (posthog.tsx
// `posthogInitOptions`, whose privacy is not-recorded.tsx `posthogPrivacy`) run by posthog-js
// itself: its full bundle and the session recorder it lazy-loads in a browser
// (`/e/static/lazy-recorder.js`, the same file). The page is React's, with controlled fields, so
// the value attributes React syncs and a textarea's text React rewrites reach the recorder as they
// do in the apps. A last `before_send` keeps each event here and drops it, so nothing leaves the
// test.
import "posthog-js/dist/lazy-recorder.js";
import { gunzipSync } from "node:zlib";
import { posthog } from "posthog-js/dist/module.full.js";
import type { CaptureResult } from "posthog-js";
import { act, useId, useState, type ChangeEvent, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { Input } from "./input.tsx";
import { Label } from "./label.tsx";
import { NotRecorded, SecretInput, SecretTextarea } from "./not-recorded.tsx";
import { posthogInitOptions } from "./posthog.tsx";
import { Textarea } from "./textarea.tsx";

test("a replay records what is typed, but no secret field, secret on screen or invitation token, and events carry none of them", async () => {
  const token = "phc_FAKE_replay_privacy_test";
  // an invitation link's page: its URL holds the token
  history.replaceState(null, "", "/invitations/FAKE-invite-token");
  // posthog-js's preloaded remote config (what `/e/array/<token>/config.js` sets): record replays
  Object.assign(window, {
    _POSTHOG_REMOTE_CONFIG: { [token]: { config: { sessionRecording: { endpoint: "/s/" } } } },
  });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(() => root.render(<Page />));

  const captured: CaptureResult[] = [];
  const options = posthogInitOptions();
  posthog.init(token, {
    ...options,
    advanced_disable_flags: true,
    before_send: [
      options.before_send,
      (event) => {
        if (event) captured.push(event);
        return null;
      },
    ],
  });
  await vi.waitFor(() => expect(posthog.sessionRecording).toMatchObject({ status: "active" }));

  await type("plain", "plain-typed");
  await type("password", "FAKE-password-typed");
  await type("openai-key", "sk-FAKE-openai-typed");
  await type("secret-value", "FAKE-secret-value-typed");
  await type("labelled", "FAKE-labelled-typed");
  await type("named", "FAKE-named-typed");
  await type("note", "note-typed sk-FAKE-pasted-key-abcdef /invitations/FAKE-invite-token");
  for (const selector of ["#visible", "#minted", "[role=status] a", "[role=status] button"])
    document.querySelector<HTMLElement>(selector)!.click();
  // the person joins and lands on the organization: `$prev_pageview_*` names the invitation page
  history.pushState(null, "", "/organizations/org_FAKE");
  await vi.waitFor(() =>
    expect(captured.filter((event) => event.event === "$pageview")).toHaveLength(2),
  );
  posthog.identify("user_FAKE");
  // the recorder flushes its buffer on unload, synchronously
  window.dispatchEvent(new Event("beforeunload"));

  const replay = JSON.stringify(
    captured.filter((event) => event.event === "$snapshot").map(inflate),
  );
  const autocapture = JSON.stringify(captured.filter((event) => event.event === "$autocapture"));
  const everything = JSON.stringify(captured.map(inflate));
  // the replay and autocapture work: typed text, and clicks and changes on ordinary elements
  expect(replay).toContain("plain-preset");
  expect(replay).toContain("plain-typed");
  expect(autocapture).toContain("Visible button");
  expect(autocapture).toContain('"attr__id":"plain"');
  // a field that says it takes a secret replays as asterisks, found by its type, its label or its
  // name even behind a wrapper the lint cannot see; an ordinary field masks a key pasted into it
  for (const typed of ["FAKE-password-typed", "FAKE-labelled-typed", "FAKE-named-typed"])
    expect(replay).toContain(`"text":"${"*".repeat(typed.length)}"`);
  expect(replay).toContain(
    `note-typed ${"*".repeat("sk-FAKE-pasted-key-abcdef".length)} /invitations/:token`,
  );
  // no secret reaches PostHog, in the replay or in any event
  for (const secret of [
    "FAKE-password",
    "sk-FAKE-openai",
    "FAKE-secret-value",
    "FAKE-labelled",
    "FAKE-named",
    "sk-FAKE-pasted-key",
    "itk_FAKE_shown_once",
    "FAKE-invite-token",
  ])
    expect(everything).not.toContain(secret);
  // secret fields and NotRecorded blocks are left out, not just masked: the replay holds an empty
  // box without their attributes, and autocapture skips them, a change on them included
  expect(replay).toContain('"id":"plain"');
  for (const id of ["openai-key", "secret-value", "minted"]) {
    expect(replay).not.toContain(`"id":"${id}"`);
    expect(autocapture).not.toContain(id);
  }
  expect(autocapture).not.toContain("Allow");
  // the page URLs PostHog records name the route, not the token
  expect(captured.filter((event) => event.event === "$pageview")).toMatchObject([
    { properties: { $pathname: "/invitations/:token" } },
    { properties: { $pathname: "/organizations/org_FAKE" } },
  ]);
  expect(captured.find((event) => event.event === "$identify")).toMatchObject({
    $set_once: { $initial_current_url: expect.stringMatching(/\/invitations\/:token$/) },
  });
  expect(replay).toMatch(/"href":"http:\/\/[^"]+\/invitations\/:token"/);
});

/** Types into a field as a person does: the value through the DOM's own setter, so React's onChange
 *  sees a change, then the input and change events. */
async function type(field: string, text: string) {
  const element = document.querySelector<HTMLInputElement>(`[data-field="${field}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!.call(
      element,
      text,
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function Page() {
  const [values, setValues] = useState({
    plain: "plain-preset",
    password: "FAKE-password-preset",
    "openai-key": "sk-FAKE-openai-preset",
    "secret-value": "FAKE-secret-value-preset",
    labelled: "FAKE-labelled-preset",
    named: "FAKE-named-preset",
    note: "note-preset",
  });
  const bind = (field: keyof typeof values) => ({
    "data-field": field,
    value: values[field],
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setValues((current) => ({ ...current, [field]: event.target.value })),
  });
  const keyId = useId();
  return (
    <form>
      <Input id="plain" {...bind("plain")} />
      {/* oxlint-disable-next-line iterate/secret-field-not-recorded -- a raw password input, to show what the replay's masking does without a SecretInput */}
      <Input id="password" type="password" {...bind("password")} />
      <SecretInput id="openai-key" {...bind("openai-key")} />
      <SecretTextarea id="secret-value" {...bind("secret-value")} />
      <Label htmlFor={keyId}>API key</Label>
      <Field id={keyId} {...bind("labelled")} />
      <Field name="apiToken" {...bind("named")} />
      <Textarea id="note" {...bind("note")} />
      <NotRecorded role="status">
        <code id="minted">itk_FAKE_shown_once</code>
        <a
          href="/.auth/login?next=%2Finvitations%2FFAKE-invite-token"
          onClick={(event) => event.preventDefault()}
        >
          Allow
        </a>
        <button type="button">Copy</button>
      </NotRecorded>
      <button type="button" id="visible">
        Visible button
      </button>
    </form>
  );
}

/** A wrapper the lint rule cannot see through: only the replay's runtime masking protects it. */
function Field(props: ComponentProps<typeof Input>) {
  return <Input {...props} />;
}

/** posthog-js gzips a full snapshot's data and a mutation's fields into latin1 strings. */
function inflate(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("\u001f\u008b"))
    return inflate(JSON.parse(gunzipSync(Buffer.from(value, "latin1")).toString("utf8")));
  if (Array.isArray(value)) return value.map(inflate);
  if (value instanceof Object)
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, inflate(entry)]));
  return value;
}
