// @vitest-environment jsdom
// What PostHog would receive from a page, with the apps' own options (posthog.tsx
// `posthogInitOptions`) run by posthog-js itself: its full bundle and the session recorder it
// lazy-loads in a browser (`/e/static/lazy-recorder.js`, the same file). The page is React's, with
// a controlled field, so the value attribute React syncs reaches the recorder as it does in the
// apps. A last `before_send` keeps each event here and drops it, so nothing leaves the test.
import "posthog-js/dist/lazy-recorder.js";
import { gunzipSync } from "node:zlib";
import { posthog } from "posthog-js/dist/module.full.js";
import type { CaptureResult } from "posthog-js";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { Input } from "./input.tsx";
import { NotRecorded } from "./not-recorded.tsx";
import { posthogInitOptions } from "./posthog.tsx";

test("a replay masks what is typed and leaves out a NotRecorded block, and no event carries an invitation token", async () => {
  const token = "phc_FAKE_replay_privacy_test";
  // an invitation link's page: its URL holds the token
  history.replaceState(null, "", "/invitations/FAKE-invite-token");
  // posthog-js's preloaded remote config (what `/e/array/<token>/config.js` sets): record replays and autocapture
  Object.assign(window, {
    _POSTHOG_REMOTE_CONFIG: {
      [token]: { config: { sessionRecording: { endpoint: "/s/" }, autocapture_opt_out: false } },
    },
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

  // types as a person does: the value through the DOM's own setter, so React's onChange sees it
  const field = document.querySelector<HTMLInputElement>("#plain")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      field,
      "FAKE-typed",
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
  for (const selector of ["#visible", "#minted", "[role=status] a"])
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
  // the replay and autocapture work: the field is there, with what was typed as asterisks
  expect(replay).toContain('"id":"plain"');
  expect(replay).toContain(`"text":"${"*".repeat("FAKE-typed".length)}"`);
  expect(autocapture).toContain("Visible button");
  // no secret reaches PostHog, in the replay or in any event
  for (const secret of ["FAKE-typed", "itk_FAKE_shown_once", "FAKE-invite-token"])
    expect(everything).not.toContain(secret);
  // a NotRecorded block is left out, not just masked: an empty box in the replay, no autocapture
  expect(replay).not.toContain('"id":"minted"');
  expect(autocapture).not.toContain("minted");
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

function Page() {
  const [plain, setPlain] = useState("");
  return (
    <form>
      <Input id="plain" value={plain} onChange={(event) => setPlain(event.target.value)} />
      <NotRecorded role="status">
        <code id="minted">itk_FAKE_shown_once</code>
        <a
          href="/.auth/login?next=%2Finvitations%2FFAKE-invite-token"
          onClick={(event) => event.preventDefault()}
        >
          Allow
        </a>
      </NotRecorded>
      <button type="button" id="visible">
        Visible button
      </button>
    </form>
  );
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
