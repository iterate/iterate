import type { ComponentProps } from "react";
import type { PostHogConfig } from "posthog-js";
import { cn } from "cn";
import {
  CREDENTIAL_AUTOCOMPLETE,
  KEY_PREFIX,
  maskKeys,
  namesSecret,
  redactSecretPaths,
} from "../lib/secret-text.ts";
import { Input } from "./input.tsx";
import { Textarea } from "./textarea.tsx";

/** PostHog's class for an element it must never capture: session replay draws an empty box of the
 *  same size in its place (`blockClass` below) and never records its content, its value or what
 *  is typed into it; autocapture, dead clicks and rage clicks skip anything inside it. */
export const NOT_RECORDED_CLASS = "ph-no-capture";

/** PostHog's privacy, the same everywhere: every `posthog.init` spreads it last (posthog.tsx
 *  `posthogInitOptions` for the apps, apps/os __root.tsx for the sign-in and consent pages), and
 *  posthog-privacy.test.ts fails on any other replay or `before_send` setting.
 *
 *  - Replays record what people type, because seeing it is the point, except secrets. With
 *    `maskAllInputs` rrweb hands every field's value to `maskInputFn`, PostHog's documented way to
 *    mask some fields and not others (https://posthog.com/docs/session-replay/privacy, "Customize
 *    input masking"). `maskSecretInput` returns asterisks for a field that says it takes a secret:
 *    a password, a credential autocomplete, or an id, name, aria-label, placeholder or label that
 *    names one (lib/secret-text.ts). That catches a raw field the lint cannot see, behind a
 *    wrapper, a spread or a `useId` label. Any other field keeps its text, with a key or an
 *    invitation link in it masked.
 *  - Anything inside a NOT_RECORDED_CLASS element (`NotRecorded`, `SecretInput`, `SecretTextarea`)
 *    is not recorded at all.
 *  - A URL path that carries a secret, an invitation link, is redacted in the replay
 *    (`maskCapturedNetworkRequestFn`, which posthog-js also runs on the page URLs it records,
 *    same page, "URL redaction") and in every event (`before_send`, as in
 *    https://posthog.com/docs/libraries/js/usage#redacting-information-in-events): `$current_url`,
 *    `$pathname`, `$prev_pageview_*`, the person's `$initial_*`, an autocaptured href.
 *  - Request and response headers and bodies are never recorded: `false` here wins over the
 *    project's settings in PostHog. (A `maskCapturedNetworkRequestFn` replaces posthog-js's own
 *    payload scrubbing, which has nothing to scrub with both off.) */
export function posthogPrivacy() {
  return {
    session_recording: {
      maskAllInputs: true,
      maskInputFn: maskSecretInput,
      blockClass: NOT_RECORDED_CLASS,
      recordHeaders: false,
      recordBody: false,
      maskCapturedNetworkRequestFn: (request) => ({
        ...request,
        name: redactSecretPaths(request.name),
      }),
    },
    before_send: (event) => event && redactSecretPathsIn(event),
  } satisfies Pick<PostHogConfig, "session_recording" | "before_send">;
}

/** A block that session replay and autocapture leave out: for a secret on screen, such as a
 *  personal access token or an invite link shown once. The lint rule
 *  iterate/secret-shown-not-recorded asks for one where it sees a secret rendered outside it. */
export function NotRecorded({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={cn(NOT_RECORDED_CLASS, className)} />;
}

/** The input for a secret (a password, an API key, a sign-in code): session replay and autocapture
 *  leave it out, like a `NotRecorded`. It is never spellchecked, because a browser's enhanced
 *  spellcheck sends the text to a server. A field that takes a secret renders as this or
 *  `SecretTextarea`; the lint rule iterate/secret-field-not-recorded says so where it can tell. */
export function SecretInput({ className, ...props }: ComponentProps<typeof Input>) {
  return (
    <Input
      autoComplete="off"
      spellCheck={false}
      {...props}
      className={cn(NOT_RECORDED_CLASS, className)}
    />
  );
}

/** The textarea for a secret, such as a project secret's value: the `SecretInput` of multi-line
 *  values. */
export function SecretTextarea({ className, ...props }: ComponentProps<typeof Textarea>) {
  return (
    <Textarea
      autoComplete="off"
      spellCheck={false}
      {...props}
      className={cn(NOT_RECORDED_CLASS, className)}
    />
  );
}

/** rrweb's `maskInputFn` (`maskInputValue` in posthog-js's bundled rrweb): called with a field's
 *  value in the full snapshot, on each input event and on each `value` change, a textarea's text
 *  included. `field` is typed by the members read here, not as the DOM's HTMLElement, because
 *  apps/os type-checks this file without the DOM lib (apps/os/src/dom.d.ts). */
function maskSecretInput(
  text: string,
  field?: {
    getAttribute(name: string): string | null;
    labels?: ArrayLike<{ textContent: string | null }> | null;
  },
) {
  if (!field) return "*".repeat(text.length);
  const attribute = (name: string) => field.getAttribute(name) ?? "";
  const takesSecret =
    attribute("type").toLowerCase() === "password" ||
    // rrweb's mark on a password input that a "show" toggle turned into a text input
    field.getAttribute("data-rr-is-password") !== null ||
    attribute("autocomplete")
      .toLowerCase()
      .split(/\s+/)
      .some((token) => CREDENTIAL_AUTOCOMPLETE.includes(token)) ||
    ["id", "name", "aria-label", "placeholder"].some((name) => namesSecret(attribute(name))) ||
    KEY_PREFIX.test(attribute("placeholder")) ||
    Array.from(field.labels || [], (label) => label.textContent || "").some(namesSecret);
  return takesSecret ? "*".repeat(text.length) : maskKeys(redactSecretPaths(text));
}

/** `value` with `redactSecretPaths` applied to every string and object key in it, except a replay
 *  batch's `$snapshot_data`: its payloads are gzipped, and `maskCapturedNetworkRequestFn` already
 *  redacted the URLs in them. The casts are safe: each branch rebuilds the value it was given with
 *  strings in place of strings, which TypeScript cannot follow through `Object.fromEntries`. */
function redactSecretPathsIn<T>(value: T): T {
  if (typeof value === "string") return redactSecretPaths(value) as T;
  if (Array.isArray(value)) return value.map(redactSecretPathsIn) as T;
  if (value && typeof value === "object" && !(value instanceof Date))
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        redactSecretPaths(key),
        key === "$snapshot_data" ? entry : redactSecretPathsIn(entry),
      ]),
    ) as T;
  return value;
}
