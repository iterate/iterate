import { Button, buttonVariants } from "@iterate-com/ui/components/button";
import { cn } from "cn";

/** A browser already signed in: who (and, for an admin signed in as someone else, who they really
 *  are), where to go on, and the way to become someone else. `signInAs` is the test person a link
 *  named, offered to a platform admin only (sign-in-as-test-person.ts): a plain POST the platform
 *  checks again, so the button itself grants nothing. */
export function SignedIn({
  email,
  impersonatedBy,
  signInAs,
  next,
  dash,
  switchAccount,
}: {
  email: string;
  impersonatedBy: string | null;
  signInAs: string | null;
  next: string;
  dash: string | null;
  switchAccount: string;
}) {
  const onward =
    next === "/login"
      ? dash && { href: dash, label: "Go to the dash" }
      : { href: next, label: signInAs ? `Continue as ${email}` : "Continue" };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        Signed in as <strong className="wrap-anywhere">{email}</strong>.
        {impersonatedBy ? (
          <>
            {" "}
            You are <strong className="wrap-anywhere">{impersonatedBy}</strong>.
          </>
        ) : null}
      </p>
      {signInAs ? (
        <form method="post" action="/login" className="flex flex-col gap-2">
          <input type="hidden" name="next" value={next} />
          <input type="hidden" name="sign_in_as" value={signInAs} />
          <Button type="submit" size="lg" className="h-auto min-h-11 whitespace-normal">
            Sign in as {signInAs} for an hour
          </Button>
          <p className="text-xs text-muted-foreground">
            Everything you do names you beside them, and both your accounts record it.
          </p>
        </form>
      ) : null}
      {onward ? (
        <a
          className={cn(
            buttonVariants({ size: "lg", variant: signInAs ? "outline" : "default" }),
            "h-11",
          )}
          href={onward.href}
        >
          {onward.label}
        </a>
      ) : null}
      <form method="post" action={switchAccount} className="flex flex-col">
        <Button type="submit" variant="ghost" className="h-9 text-[0.8rem]">
          Switch account
        </Button>
      </form>
    </div>
  );
}
