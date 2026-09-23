import { buttonVariants } from "@iterate-com/ui/components/button";
import { IterateLogo } from "@iterate-com/ui/components/iterate-logo";
import { cn } from "@iterate-com/ui/lib/utils";
import { IssuerPage } from "../issuer-page.tsx";

/** A request the authorization server refused outright, with no client to send the person back
 *  to: the reason, and the way back to iterate. */
export function InvalidRequest({ description }: { description: string }) {
  return (
    <IssuerPage className="items-center gap-4 text-center text-sm">
      <IterateLogo alt="" className="size-14" />
      <h1 className="text-xl font-semibold tracking-tight">Invalid authorization request</h1>
      <div className="flex flex-col gap-1">
        <p>The app’s request could not be accepted: {description}.</p>
        <p className="text-muted-foreground">
          Nothing was granted. Go back to the app and try again.
        </p>
      </div>
      <a
        href="/"
        // cn() lets outline's border beat the base's transparent one, as <Button> does
        className={cn(buttonVariants({ variant: "outline", size: "lg" }), "h-11 w-full")}
      >
        Back to iterate
      </a>
    </IssuerPage>
  );
}
