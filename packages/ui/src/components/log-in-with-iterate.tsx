import type { ComponentProps } from "react";
import { cn } from "../lib/utils.ts";
import { IterateLogo } from "./iterate-logo.tsx";

/** THE log-in button — the one people recognise across sites, the way Google's is one button
 *  everywhere: one rectangle, white, a thin border, the mark on the left, "Log in with iterate" in
 *  dark grey. Fixed colours on purpose (no theme tokens): it must look the same on a page that is
 *  not ours.
 *
 *  It starts the OAuth flow: an anchor to the app's login route (`iterate/app-server` serves
 *  `/.auth/login` on every app), which sends the browser to the issuer and back to `next`. The
 *  defaults are what most apps want — `next` the app's root, the `iterate` scope alone; an app that
 *  needs more (the dash: `account`, `organizations:write`) says so. */
export function LogInWithIterate({
  next = "/",
  scopes = ["iterate"],
  className,
  formAction,
  children = "Log in with iterate",
  ...props
}: Omit<ComponentProps<"a">, "href"> & {
  /** where the browser lands after the issuer — a same-origin path */
  next?: string;
  /** Start a new authorization with a same-origin POST, e.g. when provisioning another device. */
  formAction?: string;
  /** the OAuth scopes to ask for; `iterate` is always among them */
  scopes?: string[];
}) {
  const href = `/.auth/login?${new URLSearchParams({ next, scope: scopes.join(" ") })}`;
  const style = cn(
    "inline-flex h-11 items-center gap-3 rounded-lg border border-[#dadce0] bg-white pr-5 pl-3 text-[15px] font-medium tracking-[0.01em] text-[#1f1f1f] no-underline shadow-[0_1px_2px_rgba(0,0,0,0.06)] transition-colors select-none hover:bg-[#f6f7f8] focus-visible:ring-3 focus-visible:ring-black/15 focus-visible:outline-none active:bg-[#eef0f2]",
    className,
  );
  const content = (
    <>
      <IterateLogo alt="" className="size-6" />
      <span>{children}</span>
    </>
  );
  if (formAction)
    return (
      <form method="post" action={formAction}>
        <button type="submit" className={style}>
          {content}
        </button>
      </form>
    );
  return (
    <a href={href} className={style} {...props}>
      {content}
    </a>
  );
}
