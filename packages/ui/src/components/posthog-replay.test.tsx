// @vitest-environment jsdom
// What PostHog would receive from a page, with the apps' own options (posthog.tsx
// `posthogInitOptions`) run by posthog-js itself: its full bundle and the session recorder it
// lazy-loads in a browser (`/e/static/lazy-recorder.js`, the same file). `before_send` keeps each
// event here and drops it, so nothing leaves the test.
import "posthog-js/dist/lazy-recorder.js";
import { gunzipSync } from "node:zlib";
import { posthog } from "posthog-js/dist/module.full.js";
import type { CaptureResult } from "posthog-js";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { Input } from "./input.tsx";
import { NotRecorded, SecretInput, SecretTextarea } from "./not-recorded.tsx";
import { posthogInitOptions } from "./posthog.tsx";

test("a replay records what is typed, but no password, secret field or secret on screen, and autocapture skips them", async () => {
  const token = "phc_FAKE_replay_privacy_test";
  // posthog-js's preloaded remote config (what `/e/array/<token>/config.js` sets): record replays
  Object.assign(window, {
    _POSTHOG_REMOTE_CONFIG: { [token]: { config: { sessionRecording: { endpoint: "/s/" } } } },
  });
  document.body.innerHTML = renderToStaticMarkup(
    <form>
      <Input id="plain" defaultValue="plain-preset" />
      {/* oxlint-disable-next-line iterate/secret-field-not-recorded -- a raw password input, to show what the replay's masking does without a SecretInput */}
      <Input id="password" type="password" defaultValue="FAKE-password-preset" />
      <SecretInput id="openai-key" defaultValue="sk-FAKE-openai-preset" />
      <SecretTextarea id="secret-value" defaultValue="FAKE-secret-value-preset" />
      <NotRecorded role="status">
        <code id="minted">itk_FAKE_shown_once</code>
        <button type="button">Copy</button>
      </NotRecorded>
      <button type="button" id="visible">
        Visible button
      </button>
    </form>,
  );

  const captured: CaptureResult[] = [];
  posthog.init(token, {
    ...posthogInitOptions(),
    advanced_disable_flags: true,
    before_send: (event) => {
      if (event) captured.push(event);
      return null;
    },
  });
  await vi.waitFor(() => expect(posthog.sessionRecording).toMatchObject({ status: "active" }));

  type("plain", "plain-typed");
  type("password", "FAKE-password-typed");
  type("openai-key", "sk-FAKE-openai-typed");
  type("secret-value", "FAKE-secret-value-typed");
  for (const selector of ["#visible", "#minted", "[role=status] button", "#openai-key"])
    document.querySelector<HTMLElement>(selector)!.click();
  // the recorder flushes its buffer on unload, synchronously
  window.dispatchEvent(new Event("beforeunload"));

  const replay = JSON.stringify(
    captured.filter((event) => event.event === "$snapshot").map(inflate),
  );
  const autocapture = JSON.stringify(captured.filter((event) => event.event === "$autocapture"));
  // the replay and autocapture work: typed text, and a click on an ordinary button
  expect(replay).toContain("plain-preset");
  expect(replay).toContain("plain-typed");
  expect(autocapture).toContain("Visible button");
  // a password replays as asterisks of its length
  expect(replay).toContain(`"text":"${"*".repeat("FAKE-password-typed".length)}"`);
  for (const secret of [
    "FAKE-password-preset",
    "FAKE-password-typed",
    "sk-FAKE-openai-preset",
    "sk-FAKE-openai-typed",
    "FAKE-secret-value-preset",
    "FAKE-secret-value-typed",
    "itk_FAKE_shown_once",
  ]) {
    expect(replay).not.toContain(secret);
    expect(autocapture).not.toContain(secret);
  }
  expect(captured.filter((event) => event.event === "$autocapture")).toHaveLength(1);
});

function type(id: string, text: string) {
  const field = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
  field.value = text;
  field.dispatchEvent(new Event("input", { bubbles: true }));
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
