import { buttonVariants } from "@iterate-com/ui/components/button";
import { IterateLogo } from "@iterate-com/ui/components/iterate-logo";
import { IssuerPage } from "../issuer-page.tsx";

/** A request the authorization server refused outright, with no client to send the person back
 *  to: the reason, and the way back to iterate. */
export function InvalidRequest({ description }: { description: string }) {
  return (
    <IssuerPage className="text-sm">
      <IterateLogo alt="" className="size-12" />
      <h1 className="text-xl font-semibold">Invalid authorization request</h1>
      <p>The app’s request could not be accepted: {description}.</p>
      <p className="text-muted-foreground">
        Nothing was granted. Go back to the app and try again.
      </p>
      <a href="/" className={buttonVariants({ variant: "outline", size: "lg" })}>
        Back to iterate
      </a>
    </IssuerPage>
  );
}
