import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { normalizeStreamPath } from "../../../src/browser/connect.ts";
import { StreamCompactView } from "./-stream-page.tsx";

export const Route = createFileRoute("/split-stream")({
  validateSearch: (search) => ({
    left: normalizeStreamPath({ path: typeof search.left === "string" ? search.left : undefined }),
    right: normalizeStreamPath({
      path: typeof search.right === "string" ? search.right : undefined,
    }),
  }),
  component: SplitStreamRoute,
});

function SplitStreamRoute() {
  const search = Route.useSearch();
  // Re-key on the committed search so the draft inputs re-seed from it on navigation,
  // instead of syncing props into state via an effect.
  return (
    <SplitStreamControls
      key={`${search.left}::${search.right}`}
      left={search.left}
      right={search.right}
    />
  );
}

function SplitStreamControls({ left, right }: { left: string; right: string }) {
  const navigate = useNavigate();
  const [leftDraft, setLeftDraft] = useState(left);
  const [rightDraft, setRightDraft] = useState(right);

  function goToDrafts() {
    void navigate({
      to: "/split-stream",
      search: {
        left: normalizeStreamPath({ path: leftDraft }),
        right: normalizeStreamPath({ path: rightDraft }),
      },
    });
  }

  function onEnter(event: { key: string }) {
    if (event.key === "Enter") goToDrafts();
  }

  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-white font-sans text-slate-950">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2.5 border-b border-slate-200 p-3">
        <label className="grid gap-1.5 text-xs font-medium text-slate-600">
          <span>Left stream</span>
          <input
            className="min-w-0 rounded-md border border-slate-300 px-2.5 py-2 font-mono text-sm"
            value={leftDraft}
            onChange={(event) => setLeftDraft(event.currentTarget.value)}
            onKeyDown={onEnter}
          />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-slate-600">
          <span>Right stream</span>
          <input
            className="min-w-0 rounded-md border border-slate-300 px-2.5 py-2 font-mono text-sm"
            value={rightDraft}
            onChange={(event) => setRightDraft(event.currentTarget.value)}
            onKeyDown={onEnter}
          />
        </label>
        <button
          className="cursor-pointer whitespace-nowrap rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white no-underline disabled:cursor-not-allowed disabled:opacity-55"
          type="button"
          onClick={goToDrafts}
        >
          Go to streams
        </button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-px">
        <StreamCompactView streamPath={left} />
        <StreamCompactView streamPath={right} />
      </div>
    </main>
  );
}
