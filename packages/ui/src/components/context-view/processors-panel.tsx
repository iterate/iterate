// The processors: the context's table (`itx.processors.list()`) — each row's target, what it
// consumes, the facet it hosts and how often the platform had to restart it — with the LIVE STATE of
// every hosted processor and of the context itself (its core reduce), rendered by the slots the app
// fills (the SDK's `useLiveState` lives on the app's side of the boundary). A right-edge sheet.
import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../sheet.tsx";
import type { ContextViewProcessor } from "./types.tsx";

export function ProcessorsPanel({
  open,
  onClose,
  processors,
  renderCoreState,
  renderLiveState,
}: {
  open: boolean;
  onClose: () => void;
  processors: readonly ContextViewProcessor[];
  /** The context's own state — the core reduce: rules, subscriptions, schedules, the runs, the pause. */
  renderCoreState?: () => ReactNode;
  /** A hosted processor's live state, by the facet name it is hosted under. */
  renderLiveState?: (facetName: string) => ReactNode;
}) {
  const hosted = processors.filter((row) => row.hostedFacet);
  const plain = processors.filter((row) => !row.hostedFacet);
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Processors</SheetTitle>
          <SheetDescription>
            What runs on every commit of this context, and what each has folded so far.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-6 px-4 pb-6">
          {renderCoreState ? (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">The context</h3>
              {renderCoreState()}
            </section>
          ) : null}
          {hosted.map((row) => (
            <section key={row.name} className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">
                {row.name}
                <span className="ml-2 font-mono text-xs text-muted-foreground">
                  {row.hostedFacet!.className}
                  {row.hostedFacet!.restarts > 0
                    ? ` · restarted ${String(row.hostedFacet!.restarts)}×`
                    : ""}
                </span>
              </h3>
              <p className="text-xs text-muted-foreground">
                consumes {row.consumes?.length ? row.consumes.join(", ") : "every event"}
              </p>
              {renderLiveState?.(row.hostedFacet!.name)}
            </section>
          ))}
          {plain.length > 0 ? (
            <section className="flex flex-col gap-1">
              <h3 className="text-sm font-medium">Subscriptions</h3>
              {plain.map((row) => (
                <p key={row.name} className="font-mono text-xs text-muted-foreground">
                  {row.name} → {row.target}
                  {row.consumes?.length ? ` (${row.consumes.join(", ")})` : ""}
                </p>
              ))}
            </section>
          ) : null}
          {processors.length === 0 && !renderCoreState ? (
            <p className="text-sm text-muted-foreground">
              No processor is enabled on this context.
            </p>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
