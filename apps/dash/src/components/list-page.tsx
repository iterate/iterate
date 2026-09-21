// The one layout of the dash's list pages — projects, organizations: the title row with the page's
// action, then the table (packages/ui `Table`) in its frame, or the empty line when there are no
// rows. Both pages are this, so they read alike.
import type { ReactNode } from "react";

export function ListPage({
  title,
  action,
  empty,
  children,
}: {
  title: string;
  action?: ReactNode;
  /** what to say instead of the table when there is nothing to list */
  empty?: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {action}
      </div>
      {empty ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">{children}</div>
      )}
    </div>
  );
}
