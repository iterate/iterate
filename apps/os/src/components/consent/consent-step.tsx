import type { ReactNode, Ref } from "react";
import { buttonVariants } from "@iterate-com/ui/components/button";
import { cn } from "cn";
import { focusOnMount } from "../focus-on-mount.ts";

/** What every step's panel shows beside the step itself: who is signed in, what went wrong (if
 *  anything), what the platform is busy with (if anything), and where Cancel goes — the client's
 *  own refusal URL, so the app learns the person declined. */
export interface ConsentFrame {
  account: ReactNode;
  error: string | null;
  status: string | null;
  denyLocation: string;
}

/** A step's heading. It takes focus when the person moves between steps, so the change is read. */
export function StepHeading({
  ref,
  children,
}: {
  ref: Ref<HTMLHeadingElement>;
  children: ReactNode;
}) {
  return (
    <h2 ref={ref} tabIndex={-1} className="text-base font-semibold outline-none">
      {children}
    </h2>
  );
}

/** One step of the consent page, in one bordered panel: the step itself on the left; on the right
 *  the signed-in account, the step's summary (if any) and, at the bottom, its action above Cancel.
 *  Below `md` the two stack, the step first. */
export function ConsentPanel({
  account,
  error,
  status,
  denyLocation,
  summary,
  action,
  children,
}: ConsentFrame & { summary?: ReactNode; action: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-2xl border p-5 md:grid md:min-h-100 md:grid-cols-2 md:p-8">
      <div className="flex min-w-0 flex-col gap-5 md:pr-8">{children}</div>
      <aside className="flex min-w-0 flex-col gap-4 pt-6 md:gap-6 md:pt-0 md:pl-8">
        {account}
        {summary}
        <div className="mt-auto flex flex-col gap-2.5">
          {error ? (
            <p
              role="alert"
              data-type="error"
              tabIndex={-1}
              ref={focusOnMount}
              className="text-sm text-destructive outline-none"
            >
              {error}
            </p>
          ) : null}
          {status ? (
            <p role="status" className="text-sm text-muted-foreground">
              {status}
            </p>
          ) : null}
          {action}
          <a
            href={denyLocation}
            // cn() lets outline's border beat the base's transparent one, as <Button> does
            className={cn(buttonVariants({ variant: "outline", size: "lg" }), "h-11")}
          >
            Cancel
          </a>
        </div>
      </aside>
    </div>
  );
}
