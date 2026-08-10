// The durable REPL container: every Run executes as a real scope script —
// `itx.capabilityHosts.get(scopePath).runScript`, the same path agent scripts
// take — in a dedicated per-user scope, and HISTORY IS THE STREAM: the entry
// list derives from the scope's script-run-requested/settled events, so a
// reload replays the same session (tasks/durable-repl.md). The only local run
// state is the
// in-flight mutation, and even that hands off to the stream as soon as the
// request event lands.
//
// Renders under a <ProjectScope> (the project layout provides it); rides the
// tab's ONE itx session socket like every other project component.

import { Suspense, useMemo, useState } from "react";
import { ClientOnly } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { StreamEvent } from "iterate/processors";
import { useItx, useItxQuery, useStreamConnection } from "iterate/sdk/itx/react";
import { ITX_EXAMPLES } from "~/itx/examples.ts";
import { ItxRepl } from "./itx-repl.tsx";
import {
  REPL_SCRIPT_EVENT_TYPES,
  deriveReplEntries,
  pendingRunVisibleInEntries,
  runErrorAlreadyJournaled,
  wrapReplScript,
} from "./itx-scope-repl-entries.ts";

/** History window: plenty for a REPL session, bounded for pathological scopes. */
const MAX_BUFFERED_SCRIPT_EVENTS = 1_000;

export function ItxScopeRepl({
  initialCode,
  projectId,
  scopePath,
}: {
  initialCode: string;
  projectId: string;
  scopePath: string;
}) {
  // useItxQuery suspends and itx never SSRs; the route shell still renders.
  return (
    <ClientOnly fallback={<ItxReplConnecting />}>
      <Suspense fallback={<ItxReplConnecting />}>
        <ItxScopeReplConnected
          key={scopePath}
          initialCode={initialCode}
          projectId={projectId}
          scopePath={scopePath}
        />
      </Suspense>
    </ClientOnly>
  );
}

function ItxReplConnecting() {
  return (
    <div className="p-4 text-sm text-muted-foreground" data-spinner="true">
      Connecting to itx...
    </div>
  );
}

function ItxScopeReplConnected({
  initialCode,
  projectId,
  scopePath,
}: {
  initialCode: string;
  projectId: string;
  scopePath: string;
}) {
  const itx = useItx();
  const queryClient = useQueryClient();

  // 1. Scope birth — the standard idempotent create batch (default birth
  // certificate = one-hop capability fallback to the project root host).
  // Suspends, so everything below always targets a live scope.
  useItxQuery({
    key: ["repl-scope-created", projectId, scopePath],
    query: async (itx) => {
      await itx.capabilityHosts.get(scopePath).create();
      return true;
    },
  });

  // 2. The scope's assembled preamble — feeds the editor's TS worker so
  // `results` autocompletes with real types. Refetched after every settled
  // Run; stale-while-revalidate keeps this from ever re-suspending.
  const preambleQueryKey = ["repl-scope-preamble", projectId, scopePath];
  const preamble = useItxQuery({
    key: preambleQueryKey,
    query: (itx) => itx.capabilityHosts.get(scopePath).getPreamble(),
  });

  // 3. History: one kernel subscription from the start of the scope stream.
  // Re-subscribing after a reconnect replays from 0; offsets dedupe overlap.
  // (useState-in-callback is the blessed shape for push streams — see
  // itx-activity-tail.tsx; a push connection is not a query.)
  const [events, setEvents] = useState<readonly StreamEvent[]>([]);
  useStreamConnection(
    (itx) =>
      itx.streams.get(scopePath).openConnection({
        replayAfterOffset: 0,
        processEventBatch: (batch) => {
          const scriptEvents = batch.events.filter((event) =>
            (REPL_SCRIPT_EVENT_TYPES as readonly string[]).includes(event.type),
          );
          if (scriptEvents.length === 0) return;
          setEvents((previous) => {
            const lastOffset = previous.at(-1)?.offset;
            const fresh = scriptEvents.filter(
              (event) => lastOffset === undefined || event.offset > lastOffset,
            );
            return fresh.length === 0
              ? previous
              : [...previous, ...fresh].slice(-MAX_BUFFERED_SCRIPT_EVENTS);
          });
        },
      }),
    [scopePath],
  );

  // 4. The Run: wrap the typed body into the `async (itx) => { … }` shape
  // runScript expects and call it. A failed script throws here too, but its
  // settlement lands
  // on the stream regardless — the entry list is the error's home; the
  // mutation error only surfaces for pre-journal failures (see runError).
  const run = useMutation({
    mutationFn: async (body: string) => {
      return await itx.capabilityHosts.get(scopePath).runScript(wrapReplScript(body));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["itx", ...preambleQueryKey] }),
  });

  const [code, setCode] = useState(initialCode);
  const [examplesOpen, setExamplesOpen] = useState(false);

  const entries = useMemo(() => deriveReplEntries(events), [events]);
  const pendingBody = run.isPending ? run.variables || null : null;
  const pendingCode =
    pendingBody !== null && !pendingRunVisibleInEntries(entries, pendingBody) ? pendingBody : null;
  const runErrorMessage =
    run.error === null ? null : run.error instanceof Error ? run.error.message : String(run.error);
  const runError =
    runErrorMessage !== null &&
    !run.isPending &&
    !runErrorAlreadyJournaled(entries, runErrorMessage)
      ? runErrorMessage
      : null;

  function handleRun() {
    const body = code.trim();
    if (body === "" || run.isPending) return;
    setCode("");
    run.mutate(body);
  }

  function selectExample(exampleCode: string) {
    setCode(exampleCode);
    setExamplesOpen(false);
  }

  return (
    <ItxRepl
      canRun={!run.isPending && code.trim() !== ""}
      code={code}
      entries={entries}
      examples={ITX_EXAMPLES}
      examplesOpen={examplesOpen}
      onChangeCode={setCode}
      onRun={handleRun}
      onSelectExample={selectExample}
      onSetExamplesOpen={setExamplesOpen}
      pendingCode={pendingCode}
      runError={runError}
      scopePath={scopePath}
      scopePreamble={preamble?.text || null}
      status={run.isPending ? "Running..." : "Ready"}
    />
  );
}
