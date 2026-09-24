import { stepUpUrl } from "../lib/scopes.ts";

// The dash asked for `organizations:write` and the person unticked it at consent: `/.auth/login`
// with the scope asked for again re-consents and lands back where they were (`next`); the granted
// set is what `info.scopes` says.
export function AllowOrganizations({ next }: { next: string }) {
  return (
    <p className="text-sm text-muted-foreground">
      This session may not manage organizations.{" "}
      <a href={stepUpUrl(next)} className="underline underline-offset-4 hover:text-foreground">
        Allow the dash to manage organizations
      </a>
    </p>
  );
}
