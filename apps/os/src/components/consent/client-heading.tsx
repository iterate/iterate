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
    <header className="flex flex-col items-center gap-3 text-center">
      <div className="mb-3 flex items-center gap-4" aria-hidden="true">
        <IterateLogo alt="" className="size-16 rounded-[22px]" />
        <span className="text-xl text-muted-foreground">⇄</span>
        <Avatar
          data-testid="client-logo"
          className="size-16 rounded-[22px] bg-muted after:rounded-[22px]"
        >
          {clientLogoUri ? (
            <AvatarImage
              src={clientLogoUri}
              referrerPolicy="no-referrer"
              className="rounded-[22px] object-contain p-2"
            />
          ) : null}
          <AvatarFallback className="rounded-[22px] text-xl font-semibold text-foreground">
            {clientName.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
      </div>
      <h1 className="text-2xl leading-tight font-semibold tracking-tight text-balance md:text-[2rem]">
        {clientName} wants to access your account
      </h1>
      {clientDomain ? <p className="text-sm text-muted-foreground">{clientDomain}</p> : null}
    </header>
  );
}
