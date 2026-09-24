import type { ComponentProps } from "react";
import type { SessionRecordingOptions } from "posthog-js";
import { cn } from "cn";
import { Input } from "./input.tsx";
import { Textarea } from "./textarea.tsx";

/** PostHog's class for an element it must never capture: session replay draws an empty box of the
 *  same size in its place (`blockClass` below) and never records its content, its value or what
 *  is typed into it; autocapture, dead clicks and rage clicks skip anything inside it. */
export const NOT_RECORDED_CLASS = "ph-no-capture";

/** Session replay's privacy, the same in every app (posthog.tsx, and apps/os's sign-in and consent
 *  pages). What people type is recorded, because seeing it is the point of a replay, with two
 *  exceptions. A password input replays as `***`: rrweb keeps masking it after a "show" toggle
 *  turns it into a text input. Anything inside a NOT_RECORDED_CLASS element (`NotRecorded`,
 *  `SecretInput`, `SecretTextarea`) is not recorded at all. Request and response headers and
 *  bodies are never recorded; `false` here wins over the project's settings in PostHog. */
export const sessionRecordingPrivacy = {
  maskAllInputs: false,
  maskInputOptions: { password: true },
  blockClass: NOT_RECORDED_CLASS,
  recordHeaders: false,
  recordBody: false,
} satisfies SessionRecordingOptions;

/** A block that session replay and autocapture leave out: for a secret on screen, such as a
 *  personal access token or an invite link shown once. */
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
