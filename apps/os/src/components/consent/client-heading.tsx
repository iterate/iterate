import { Avatar, AvatarFallback, AvatarImage } from "@iterate-com/ui/components/avatar";
import { IterateLogo } from "@iterate-com/ui/components/iterate-logo";

/** Who is asking: iterate and the client side by side, the client's name, and — independently of
 *  the name and logo the client supplies — the domain its metadata came from. A logo that fails to
 *  load leaves the client's initials. */
export function ClientHeading({
  clientName,
  clientLogoUri,
  clientDomain,
}: {
  clientName: string;
  clientLogoUri?: string;
  clientDomain?: string;
}) {
  return (
    <header className="flex flex-col items-center gap-4 text-center">
      <div className="flex items-center gap-3" aria-hidden="true">
        <IterateLogo alt="" className="size-12" />
        <span className="text-muted-foreground">⇄</span>
        <Avatar
          data-testid="client-logo"
          className="size-12 rounded-[22.37%] after:rounded-[22.37%]"
        >
          {clientLogoUri ? (
            <AvatarImage
              src={clientLogoUri}
              referrerPolicy="no-referrer"
              className="rounded-[22.37%]"
            />
          ) : null}
          <AvatarFallback className="rounded-[22.37%] font-semibold">
            {clientName.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
      </div>
      <h1 className="text-xl font-semibold text-balance">
        {clientName} wants to access your account
      </h1>
      {clientDomain ? <p className="-mt-2 text-sm text-muted-foreground">{clientDomain}</p> : null}
    </header>
  );
}
