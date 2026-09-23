import { Avatar, AvatarFallback, AvatarImage } from "@iterate-com/ui/components/avatar";
import { Button } from "@iterate-com/ui/components/button";

/** Who is approving — their picture (or initial) and address — and Switch account, which signs out
 *  and comes back to this request through sign-in. */
export function SignedInAccount({
  email,
  picture,
  switchAccount,
}: {
  email: string;
  picture?: string;
  switchAccount: string;
}) {
  return (
    <section
      aria-label="Signed-in account"
      className="flex items-center gap-3 rounded-lg bg-muted/60 px-3 py-2"
    >
      <Avatar>
        {picture ? <AvatarImage src={picture} referrerPolicy="no-referrer" /> : null}
        <AvatarFallback>{email.slice(0, 1).toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-1 flex-col text-sm leading-tight">
        <span className="text-xs text-muted-foreground">Signed in as</span>
        <strong className="truncate font-medium">{email}</strong>
      </div>
      <form method="post" action={switchAccount}>
        <Button type="submit" variant="ghost" size="sm">
          Switch account
        </Button>
      </form>
    </section>
  );
}
