import type { ReactNode } from "react";
import { cn } from "@iterate-com/ui/lib/utils";

/** The frame of every issuer page: one centred column on a plain background. */
export function IssuerPage({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <main className="flex min-h-svh justify-center px-4 py-10 sm:items-center sm:py-16">
      <div className={cn("flex w-full max-w-sm flex-col gap-6", className)}>{children}</div>
    </main>
  );
}

/** A refusal or failure shown where the person acted. */
export function ErrorMessage({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}
