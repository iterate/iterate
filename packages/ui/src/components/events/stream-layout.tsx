import type { ReactNode } from "react";

import { cn } from "@iterate-com/ui/lib/utils";

/**
 * Structural shell for a stream UI.
 *
 * The stream product layout is intentionally just three vertical regions:
 * header, main content, and message input. Event reducers decide what goes into
 * slots; this layout only keeps those slots in predictable screen positions.
 */
export function EventsStreamLayout({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex h-full min-h-0 flex-1 flex-col overflow-hidden", className)}>
      {children}
    </section>
  );
}

/**
 * Fixed top region for stream status and other header-slot elements.
 */
export function EventsStreamLayoutHeader({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <header
      data-slot="event-stream-header"
      className={cn("shrink-0 border-b bg-background/95 px-4 py-2", className)}
    >
      {children}
    </header>
  );
}

/**
 * Flexible middle region that owns the scrollable stream body.
 */
export function EventsStreamLayoutMain({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <main data-slot="event-stream-main" className={cn("min-h-0 flex-1 overflow-hidden", className)}>
      {children}
    </main>
  );
}

/**
 * Fixed bottom region for composer UI and input-slot affordances.
 */
export function EventsStreamLayoutMessageInput({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <footer
      data-slot="event-stream-message-input"
      className={cn(
        "supports-backdrop-filter:bg-background/80 shrink-0 border-t bg-background/95 px-4 py-4",
        className,
      )}
    >
      {children}
    </footer>
  );
}
