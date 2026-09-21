// A context's activity — the dash's use of the general-purpose context view (packages/ui) over the
// SDK's hooks: the log (live), the processors table, who is here, the fact renderers, and every
// hosted processor's live state. `ensureProcessor` names the first-party fold to enable on first
// visit (the account's, the organization's) when the context has none yet: the facts are on the
// log either way; the fold is what the panel shows folded.
import { useEffect, useRef, type ReactNode } from "react";
import {
  useContextLog,
  useContextPresence,
  useContextProcessors,
  type ContextLogItx,
  type ContextTablesItx,
} from "iterate/next/react";
import { ContextView } from "@iterate-com/ui/components/context-view/context-view";
import { factRenderers } from "../lib/fact-renderers.tsx";
import { FacetLiveState } from "./facet-live-state.tsx";

export type ActivityItx = ContextLogItx &
  ContextTablesItx & {
    invoke(call: string): Promise<unknown>;
    processors: ContextTablesItx["processors"] & {
      enable(name: string): Promise<unknown>;
    };
  };

export function ContextActivity({
  itx,
  title,
  ensureProcessor,
}: {
  itx: ActivityItx | undefined;
  title: ReactNode;
  ensureProcessor?: string;
}) {
  const log = useContextLog(itx);
  const processors = useContextProcessors(itx, log.events);
  const presence = useContextPresence(itx, log.events);
  // The first visit enables the context's own fold, once per context: the row is durable, so the
  // check is a read of the table, and only a table that has loaded and lacks the row asks for it.
  // A page that swaps contexts on one mount (one route, another organization) asks again for the
  // new one.
  const enabledFor = useRef<ActivityItx | undefined>(undefined);
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
      events={log.events}
      caughtUp={log.caughtUp}
      error={log.error || processors.error}
      renderers={factRenderers}
      processors={processors.rows}
      presence={presence}
      renderCoreState={() => <FacetLiveState itx={itx} name="core" />}
      renderLiveState={(name) => <FacetLiveState itx={itx} name={name} />}
    />
  );
}
