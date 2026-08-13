// The durable REPL container: every Run executes as a real scope script —
// `itx.capabilityHosts.get(scopePath).runScript`, the same path agent scripts
// take — in a session scope, and HISTORY IS THE STREAM: the entry list
// derives from the scope's script-run-requested/settled events, so a reload
// replays the same session (tasks/durable-repl.md). The only local run state
// is the in-flight mutation, and even that hands off to the stream as soon as
// the request event lands.
//
// LAZY BY DESIGN: nothing exists until the first Run. Waking a Stream
// Durable Object BIRTHS it (stream/created on first boot), so while a
// session is unborn this component makes NO calls that touch the session
// path — no capability-host reads, no stream connection, no activity tail.
// Existence is read from `itx.streams.list()` (a project-root read), and the
// first Run's mutation is the one code path that births the scope
// (idempotent create) and submits the script.
//
// Renders under a <ProjectScope> (the project layout provides it); rides the
// tab's ONE itx session socket like every other project component.

import { Suspense, useMemo, useRef, useState } from "react";
import { ClientOnly } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StreamEvent } from "iterate/processors";
import { useItx, useStreamConnection } from "iterate/sdk/itx/react";
import { ItxActivityTail } from "./itx-activity-tail.tsx";
import { ItxRepl } from "./itx-repl.tsx";
import {
  REPL_SCRIPT_EVENT_TYPES,
  deriveReplEntries,
  pendingRunVisibleInEntries,
  runErrorAlreadyJournaled,
  wrapReplScript,
  type PendingRun,
} from "./itx-scope-repl-entries.ts";
import { ITX_EXAMPLES } from "~/itx/examples.ts";
import { KNOWN_STREAMS_QUERY, newReplSessionPath } from "~/lib/repl-session.ts";
import type { StreamListItem } from "~/itx-api.generated.ts";

/** History window: plenty for a REPL session, bounded for pathological scopes. */
const MAX_BUFFERED_SCRIPT_EVENTS = 1_000;

export function ItxScopeRepl({
  initialCode,
  onNewSession,
  onSessionEstablished,
  projectId,
  scopePath,
}: {
  initialCode: string;
  /** Navigate to a fresh unborn session URL (the page header button). */
  onNewSession: () => void;
  /** The first Run minted+birthed this session — put its path in the URL
   * (router replace). Called when that run settles (never mid-run — the
   * replace remounts the console) and only when scopePath was null. */
  onSessionEstablished: (sessionPath: string) => void;
  projectId: string;
  /** The session's stream path, or null for an unborn bare-/repl visit —
   * the first Run mints the path (so its timestamp reflects when work
   * actually started, not when the page was opened). */
  scopePath: string | null;
}) {
  // useItx suspends once on first connect and itx never SSRs; the route
  // shell still renders. Keyed by project AND session: the same component
  // stays mounted across route param changes, so without the key project A's
  // event buffer, editor text, and mutation state would survive into
  // project B (and the offset dedupe would swallow B's replay).
  return (
    <ClientOnly fallback={<ItxReplConnecting />}>
      <Suspense fallback={<ItxReplConnecting />}>
        <ItxScopeReplConnected
          key={`${projectId}:${scopePath || "unborn"}`}
          initialCode={initialCode}
          onNewSession={onNewSession}
          onSessionEstablished={onSessionEstablished}
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
  onNewSession,
  onSessionEstablished,
  projectId,
  scopePath,
}: {
  initialCode: string;
  onNewSession: () => void;
  onSessionEstablished: (sessionPath: string) => void;
  projectId: string;
  scopePath: string | null;
}) {
  const itx = useItx();
  const queryClient = useQueryClient();

  // 1. Does this session's stream exist yet? A project-root read — it never
  // wakes (and therefore never births) the session stream. Non-suspending so
  // the editor renders immediately; failures degrade to "unborn", which
  // still runs fine (the Run mutation's create is idempotent).
  const knownStreams = useQuery({
    queryKey: ["itx", ...KNOWN_STREAMS_QUERY.key(projectId)],
    queryFn: () => itx.streams.list().catch((): StreamListItem[] => []),
    staleTime: KNOWN_STREAMS_QUERY.staleTimeMs,
  });

  // 2. The Run: mint the path if this is the first Run of an unborn bare
  // visit, birth the scope (the standard idempotent create batch — a second
  // tab racing it appends the identical events and both proceed), put the
  // session in the URL, then submit the script. The ONE code path that
  // creates anything.
  // Session paths THIS component successfully birthed. Deliberately local,
  // not a query derivation: it is the race-free birth signal — a background
  // streams-list refetch can briefly overwrite the primed cache while
  // stream/created is still propagating into project state, and the signal
  // must also stay false when create() itself fails. Twin records on
  // purpose: the ref is what settle-time callbacks read (immune to closure
  // staleness — a settle racing the post-create re-render still sees the
  // birth), the state is what re-renders `born` below.
  const bornPathsRef = useRef(new Set<string>());
  const [bornPaths, setBornPaths] = useState<readonly string[]>([]);
  const run = useMutation({
    mutationFn: async ({ body, path }: PendingRun & { path: string }) => {
      const host = itx.capabilityHosts.get(path);
      await host.create();
      bornPathsRef.current.add(path);
      setBornPaths((previous) => (previous.includes(path) ? previous : [...previous, path]));
      // The primed cache is what lets the REMOUNTED session page consider
      // itself born after the URL replace, without waiting for
      // stream/created to reach project state.
      queryClient.setQueryData(
        ["itx", ...KNOWN_STREAMS_QUERY.key(projectId)],
        (previous: StreamListItem[] | undefined) =>
          (previous || []).some((stream) => stream.path === path)
            ? previous
            : [...(previous || []), { createdAt: new Date().toISOString(), path }],
      );
      return await host.runScript(wrapReplScript(body));
    },
    onSettled: (_result, _error, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ["itx", "repl-scope-preamble", projectId, variables.path],
      });
      // Put the session in the URL only once the run SETTLES: replacing
      // mid-run would remount the console (new component key), resetting the
      // editor and dropping the local pending row while the script still
      // executes. A failed SCRIPT still establishes (the stream exists and
      // journaled the error, which the session page replays) — but a failed
      // BIRTH must not: bornPaths is only recorded after create() resolves,
      // so a birth failure stays on the unborn page with the mutation error
      // visible.
      if (!scopePath && bornPathsRef.current.has(variables.path)) {
        onSessionEstablished(variables.path);
      }
    },
  });

  // Born = safe to touch the session stream: it provably exists, this very
  // component birthed it, or events already arrived (sticky evidence across
  // background list refetches). NOT merely "a Run was submitted" — opening
  // the read connection would itself wake (and therefore birth) the stream,
  // so a failed create() must leave every clause false.
  const [events, setEvents] = useState<readonly StreamEvent[]>([]);
  const activeScopePath = scopePath || (run.variables ? run.variables.path : null);
  const born =
    !!activeScopePath &&
    (!!events.length ||
      bornPaths.includes(activeScopePath) ||
      (knownStreams.data || []).some((stream) => stream.path === activeScopePath));

  // 3. History: one kernel subscription from the start of the scope stream,
  // opened only once born. Re-subscribing after a reconnect replays from 0;
  // offsets dedupe overlap. (useState-in-callback is the blessed shape for
  // push streams — see itx-activity-tail.tsx; a push connection is not a
  // query.)
  useStreamConnection(
    (itx) =>
      itx.streams.get(activeScopePath!).openConnection({
        replayAfterOffset: 0,
        processEventBatch: (batch) => {
          const scriptEvents = batch.events.filter((event) =>
            (REPL_SCRIPT_EVENT_TYPES as readonly string[]).includes(event.type),
          );
          if (!scriptEvents.length) return;
          setEvents((previous) => {
            const lastOffset = previous.at(-1)?.offset;
            const fresh = scriptEvents.filter(
              (event) => !Number.isFinite(lastOffset) || event.offset > lastOffset,
            );
            return fresh.length === 0
              ? previous
              : [...previous, ...fresh].slice(-MAX_BUFFERED_SCRIPT_EVENTS);
          });
        },
      }),
    [activeScopePath],
    { enabled: born },
  );

  // 4. The scope's assembled preamble — feeds the editor's TS worker so
  // `results` autocompletes with real types. Best-effort and unborn-safe:
  // disabled until born (no preamble exists before the first settle anyway),
  // errors fall back to the itx-only types. Refetched after every settled
  // Run (see the mutation's onSettled).
  const preamble = useQuery({
    enabled: born,
    queryKey: ["itx", "repl-scope-preamble", projectId, activeScopePath],
    queryFn: () =>
      itx.capabilityHosts
        .get(activeScopePath!)
        .getPreamble()
        .catch(() => null),
    staleTime: 5_000,
  });

  const [code, setCode] = useState(initialCode);
  const [examplesOpen, setExamplesOpen] = useState(false);

  const entries = useMemo(() => deriveReplEntries(events), [events]);
  const pendingRun = run.isPending ? run.variables : undefined;
  const pendingCode =
    pendingRun && !pendingRunVisibleInEntries(entries, pendingRun) ? pendingRun.body : null;
  const runErrorMessage = !run.error
    ? null
    : run.error instanceof Error
      ? run.error.message
      : String(run.error);
  const runError =
    runErrorMessage && !run.isPending && !runErrorAlreadyJournaled(entries, runErrorMessage)
      ? runErrorMessage
      : null;

  function handleRun() {
    const body = code.trim();
    if (body === "" || run.isPending) return;
    setCode("");
    run.mutate({
      afterOffset: events.at(-1)?.offset || 0,
      body,
      path: activeScopePath || newReplSessionPath(new Date()),
    });
  }

  function selectExample(exampleCode: string) {
    setCode(exampleCode);
    setExamplesOpen(false);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        <ItxRepl
          canRun={!run.isPending && code.trim() !== ""}
          code={code}
          entries={entries}
          examples={ITX_EXAMPLES}
          examplesOpen={examplesOpen}
          onChangeCode={setCode}
          onNewSession={onNewSession}
          onRun={handleRun}
          onSelectExample={selectExample}
          onSetExamplesOpen={setExamplesOpen}
          pendingCode={pendingCode}
          runError={runError}
          scopePath={activeScopePath}
          scopePreamble={preamble.data?.text || null}
          status={run.isPending ? "Running..." : "Ready"}
        />
      </div>
      {/* The tail rides the session stream too, so it must stay lazy: mounting
          it opens a connection, and a connection wakes (births) the stream. */}
      {born && activeScopePath ? (
        <div className="flex max-h-56 min-h-0 flex-col">
          <ItxActivityTail key={`${projectId}:${activeScopePath}`} path={activeScopePath} />
        </div>
      ) : null}
    </div>
  );
}
