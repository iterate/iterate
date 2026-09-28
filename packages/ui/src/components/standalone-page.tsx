import type { ReactNode } from "react";
import { cn } from "cn";

/** The frame of a page outside any app's shell — the issuer's sign-in and consent pages, and the
 *  Dash's secret collection link — so they read as one family: one centred column on a plain
 *  background. A `wide` page — the consent page's two columns — starts at the top instead of the
 *  middle of the screen. */
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
        !wide && "items-center sm:py-16",
      )}
    >
      <div className={cn("flex w-full flex-col gap-6", wide ? "max-w-4xl" : "max-w-sm", className)}>
        {children}
      </div>
    </main>
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
