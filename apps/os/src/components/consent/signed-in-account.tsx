import { useHydrated } from "@tanstack/react-router";
import { Avatar, AvatarFallback, AvatarImage } from "@iterate-com/ui/components/avatar";
import { Button } from "@iterate-com/ui/components/button";

/** Who is approving — their picture (or initial) and address, wrapped rather than cut when long —
 *  and Switch account, which signs out and comes back to this request through sign-in. A platform
 *  admin also gets "Sign in as someone else…" (`onSignInAsSomeoneElse`, consent-card.tsx). */
export function SignedInAccount({
  email,
  picture,
  switchAccount,
  onSignInAsSomeoneElse,
}: {
  email: string;
  picture?: string;
  switchAccount: string;
  onSignInAsSomeoneElse?: () => void;
}) {
  // the link does nothing until React owns it; disabled, a test (or a quick hand) waits for that
  const hydrated = useHydrated();
  return (
    <section
      aria-label="Signed-in account"
      className="flex items-start gap-3.5 rounded-xl border p-4"
    >
      <Avatar className="size-11 rounded-lg after:rounded-lg">
        {picture ? (
          <AvatarImage src={picture} referrerPolicy="no-referrer" className="rounded-lg" />
        ) : null}
        <AvatarFallback className="rounded-lg text-base">
          {email.slice(0, 1).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-sm">
        <span className="text-xs text-muted-foreground">Signed in as</span>
        <strong className="font-medium wrap-anywhere">{email}</strong>
        <form method="post" action={switchAccount}>
          <Button
            type="submit"
            variant="link"
            size="xs"
            className="px-0 text-muted-foreground underline hover:text-foreground"
          >
            Switch account
          </Button>
        </form>
        {onSignInAsSomeoneElse ? (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="px-0 text-muted-foreground underline hover:text-foreground"
            disabled={!hydrated}
            onClick={onSignInAsSomeoneElse}
          >
            Sign in as someone else…
          </Button>
        ) : null}
      </div>
    </section>
  );
}
