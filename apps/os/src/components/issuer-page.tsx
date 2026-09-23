import type { ReactNode } from "react";
import { cn } from "@iterate-com/ui/lib/utils";

/** The frame of every issuer page: one centred column on a plain background. A `wide` page — the
 *  consent page's two columns — starts at the top instead of the middle of the screen. */
export function IssuerPage({
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
