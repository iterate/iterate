import { useHydrated } from "@tanstack/react-router";
import { Button, buttonVariants } from "@iterate-com/ui/components/button";
import { IterateLogo } from "@iterate-com/ui/components/iterate-logo";
import { cn } from "cn";
import type { ConsentView } from "../../consent.ts";
import { IssuerPage } from "../issuer-page.tsx";

/** A client asking only who the person is (the `/oauth2/userinfo` resource): it learns their email
 *  and reaches nothing. Continue is a plain POST to this very authorization URL (consent.ts
 *  `approve`). */
export function IdentifyCard({ view }: { view: Extract<ConsentView, { kind: "identify" }> }) {
  const hydrated = useHydrated();
  return (
    <IssuerPage className="items-center gap-4 text-center text-sm">
      <IterateLogo alt="" className="size-14" />
      <h1 className="text-xl font-semibold tracking-tight text-balance">
        Confirm it's you to {view.clientDomain || view.clientName}
      </h1>
      <div className="flex flex-col gap-1">
        <p>
          {view.clientName} learns that you are <strong>{view.email}</strong>.
        </p>
        <p className="text-muted-foreground">
          Nothing else: it gets no access to your projects or your account.
        </p>
      </div>
      <form method="post" className="w-full">
        <Button type="submit" size="lg" className="h-11 w-full" disabled={!hydrated}>
          Continue as {view.email}
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
