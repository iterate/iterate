import { useHydrated } from "@tanstack/react-router";
import { Button, buttonVariants } from "@iterate-com/ui/components/button";
import { IterateLogo } from "@iterate-com/ui/components/iterate-logo";
import { cn } from "cn";
import type { ConsentView } from "../../consent.ts";
import { IssuerPage } from "../issuer-page.tsx";

/** A platform admin's "view this app as someone": who they will be, for how long, and that it is
 *  recorded. Continue is a plain POST to this very authorization URL (consent.ts `#impersonate`). */
export function ImpersonateCard({ view }: { view: Extract<ConsentView, { kind: "impersonate" }> }) {
  const hydrated = useHydrated();
  return (
    <IssuerPage className="items-center gap-4 text-center text-sm">
      <IterateLogo alt="" className="size-14" />
      <h1 className="text-xl font-semibold tracking-tight text-balance">
        View {view.clientName} as {view.target}
      </h1>
      <div className="flex flex-col gap-1">
        <p>
          For one hour, {view.clientName} acts as <strong>{view.target}</strong>: it sees and can
          change what they can.
        </p>
        <p className="text-muted-foreground">
          You are signed in as {view.email}. Everything it does names you beside them, and their
          account records that you started it.
        </p>
      </div>
      <form method="post" className="w-full">
        <Button type="submit" size="lg" className="h-11 w-full" disabled={!hydrated}>
          View as {view.target}
        </Button>
      </form>
      <a
        href={view.denyLocation}
        // cn() lets outline's border beat the base's transparent one, as <Button> does
        className={cn(buttonVariants({ variant: "outline", size: "lg" }), "h-11 w-full")}
      >
        Cancel
      </a>
    </IssuerPage>
  );
}
