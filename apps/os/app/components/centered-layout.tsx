import type { ReactNode } from "react";

interface CenteredLayoutProps {
  children: ReactNode;
}

/**
 * Full-screen centered layout for standalone pages (login, new-organization, settings).
 * Provides consistent padding, centering, and background.
 *
 * Content should use `w-full max-w-md space-y-6` (or similar) for proper sizing.
 *
 * @example
 * <CenteredLayout>
 *   <div className="w-full max-w-md space-y-6">
 *     <h1>Page Title</h1>
 *     <form>...</form>
 *   </div>
 * </CenteredLayout>
 */
export function CenteredLayout({ children }: CenteredLayoutProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/50 px-4 py-8">
      {children}
    </div>
  );
}
