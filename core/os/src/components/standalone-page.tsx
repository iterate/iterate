import type { ReactNode } from "react";
import { cn } from "cn";

/** The frame of a page outside any app's shell — the issuer's sign-in and consent pages, and the
 *  Dash's secret collection link — so they read as one family: one column on a plain background,
 *  centred on a larger screen. On a phone it starts at the top, as a phone's pages do. A `wide`
 *  page — the consent page's two columns — starts at the top on every screen. */
export function StandalonePage({
  children,
  className,
  wide,
}: {
  children: ReactNode;
  className?: string;
  wide?: boolean;
}) {
  return (
    <main
      className={cn(
        "flex min-h-svh justify-center px-4 py-8 sm:py-12",
        !wide && "items-start sm:items-center sm:py-16",
      )}
    >
      <div className={cn("flex w-full flex-col gap-6", wide ? "max-w-4xl" : "max-w-sm", className)}>
        {children}
      </div>
    </main>
  );
}

/** A narrow page's one card. Its chrome — border, rounding, shadow, padding — only from `sm` up: on
 *  a phone the content sits on the page itself, with nothing drawn around it. */
export function StandaloneCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-5 text-card-foreground sm:rounded-xl sm:border sm:bg-card sm:p-6 sm:shadow-xs",
        className,
      )}
    >
      {children}
    </section>
  );
}

/** A refusal or failure shown where the person acted. */
export function ErrorMessage({ children }: { children: ReactNode }) {
  return (
    <p role="alert" data-type="error" className="text-sm text-destructive">
      {children}
    </p>
  );
}
