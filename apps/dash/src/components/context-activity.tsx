// A context's activity — the dash's use of the general-purpose context view (packages/ui) over the
// SDK's ONE hook: the log (live), the processors table, who is here, the fact renderers, and every
// hosted processor's live state. `ensureProcessor` names the first-party fold to enable on first
// visit (the account's, the organization's) when the context has none yet: the facts are on the
// log either way; the fold is what the panel shows folded.
import { useEffect, useRef, type ReactNode } from "react";
import { useIterateContext, type IterateContextHandle } from "iterate/next/react";
import { ContextView } from "@iterate-com/ui/components/context-view/context-view";
import type { ContextViewState } from "@iterate-com/ui/components/context-view/context-view-search";
import { LiveStateValue } from "@iterate-com/ui/components/context-view/live-state-value";
import { factRenderers } from "../lib/fact-renderers.tsx";

export type ActivityItx = IterateContextHandle & {
  processors: IterateContextHandle["processors"] & {
    enable(name: string): Promise<unknown>;
  };
};

export function ContextActivity({
  itx,
  title,
  ensureProcessor,
  state,
  onStateChange,
}: {
  itx: ActivityItx | undefined;
  title: ReactNode;
  ensureProcessor?: string;
  /** The view's state — the route's search (`validateSearch: ContextViewState`), so the page is a link. */
  state: ContextViewState;
  onStateChange: (patch: Partial<ContextViewState>) => void;
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
      events={iterateContext.events}
      caughtUp={iterateContext.caughtUp}
      error={iterateContext.error || processors.error}
      renderers={factRenderers}
      processors={processors.rows}
      presence={iterateContext.presence}
      renderCoreState={() => <LiveStateValue state={iterateContext.liveState.core} />}
      renderLiveState={(name) => <LiveStateValue state={iterateContext.liveState[name]} />}
      state={state}
      onStateChange={onStateChange}
    />
  );
}
