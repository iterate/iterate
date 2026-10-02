// A context's activity — the dash's use of the general-purpose context view (packages/ui) over the
// SDK's ONE hook, with the dash's fact renderers. `ensureProcessor` names the first-party fold to enable on first
// visit (the account's, the organization's) when the context has none yet: the facts are on the
// log either way; the fold is what the panel shows folded. The view's composer appends as the
// signed-in person (the platform stamps the principal).
import { useEffect, useRef, type ReactNode } from "react";
import type { IterateContextApi } from "iterate/api";
import { useIterateContext, type IterateContextHandle } from "iterate/react";
import { ContextView } from "@iterate-com/ui/components/context-view/context-view";
import type { ContextPathLinks } from "@iterate-com/ui/components/context-view/context-path";
import type { ContextViewState } from "@iterate-com/ui/components/context-view/context-view-search";
import { factRenderers } from "../lib/fact-renderers.tsx";

export type ActivityItx = IterateContextHandle & {
  append: IterateContextApi["append"];
  processors: { enable(name: string): Promise<unknown> };
};

export function ContextActivity({
  itx,
  title,
  ensureProcessor,
  state,
  onStateChange,
  pathLinks,
}: {
  itx: ActivityItx | undefined;
  title: ReactNode;
  ensureProcessor?: string;
  /** The view's state — the route's search (`validateSearch: ContextViewState`), so the page is a link. */
  state: ContextViewState;
  onStateChange: (patch: Partial<ContextViewState>) => void;
  /** Where a context path a row names links (the explorer's); omitted = plain text. */
  pathLinks?: ContextPathLinks;
}) {
  // `liveState` omitted: the hook opens the core reduce's live state and every hosted facet's as the
  // processors table it holds loads — exactly what the panel shows.
  const iterateContext = useIterateContext(itx);
  // The first visit enables the context's own fold, once per context: the row is durable, so the
  // check is a read of the table, and only a table that has loaded and lacks the row asks for it.
  // A page that swaps contexts on one mount (one route, another organization) asks again for the
  // new one.
  const enabledFor = useRef<ActivityItx | undefined>(undefined);
  const { processors } = iterateContext;
  useEffect(() => {
    if (!itx || !ensureProcessor || !processors.loaded || enabledFor.current === itx) return;
    if (processors.rows.some((row) => row.name === ensureProcessor)) return;
    enabledFor.current = itx;
    itx.processors.enable(ensureProcessor).catch(() => {
      if (enabledFor.current === itx) enabledFor.current = undefined; // let a later render retry
    });
  }, [itx, ensureProcessor, processors.loaded, processors.rows]);
  return (
    <ContextView
      title={title}
      context={iterateContext}
      renderers={factRenderers}
      state={state}
      onStateChange={onStateChange}
      pathLinks={pathLinks}
      onAppend={itx ? (events) => itx.append(...events) : undefined}
      // the feed scrolls itself: it fills what the page leaves it, never less than 24rem
      className="min-h-96 flex-1"
    />
  );
}
