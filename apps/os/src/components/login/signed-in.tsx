import { Button, buttonVariants } from "@iterate-com/ui/components/button";

/** A browser already signed in: who, where to go on, and the way to become someone else. */
export function SignedIn({
  email,
  next,
  dash,
  switchAccount,
}: {
  email: string;
  next: string;
  dash: string | null;
  switchAccount: string;
}) {
  const onward =
    next === "/login"
      ? dash && { href: dash, label: "Go to the dash" }
      : { href: next, label: "Continue" };
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">
        Signed in as <strong>{email}</strong>.
      </p>
      {onward ? (
        <a className={buttonVariants({ size: "lg" })} href={onward.href}>
          {onward.label}
        </a>
      ) : null}
      <form method="post" action={switchAccount} className="flex flex-col">
        <Button type="submit" variant="ghost">
          Switch account
        </Button>
      </form>
    </div>
  );
}
