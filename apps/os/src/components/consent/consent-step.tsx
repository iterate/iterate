import type { ReactNode, Ref } from "react";
import { buttonVariants } from "@iterate-com/ui/components/button";

/** Module-level so its identity is stable: React calls it once, as the alert appears, and the
 *  refusal is read where the person acted. */
function focusOnMount(node: HTMLElement | null) {
  node?.focus();
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

/** Each step's last lines: what went wrong, if anything, then its action and Cancel — the
 *  client's own refusal URL, so the app learns the person declined. */
export function ConsentFooter({
  error,
  denyLocation,
  children,
}: {
  error: string | null;
  denyLocation: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <p
          role="alert"
          tabIndex={-1}
          ref={focusOnMount}
          className="text-sm text-destructive outline-none"
        >
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2 *:flex-1">
        {children}
        <a href={denyLocation} className={buttonVariants({ variant: "outline", size: "lg" })}>
          Cancel
        </a>
      </div>
    </div>
  );
}
