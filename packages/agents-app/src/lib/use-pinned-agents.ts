// The agents this person pinned in the sidebar, per project, in this browser's localStorage — a
// viewer's convenience, never the project's data. Read after mount (the server render has no
// storage); storage that throws (a private window, blocked site data) leaves pins in memory only.
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

const Pins = z.array(z.string());
const NONE: ReadonlySet<string> = new Set();

function storageKey(project: string) {
  return `iterate-agents:pinned:${project}`;
}

function readPins(project: string): Set<string> {
  try {
    const parsed = Pins.safeParse(JSON.parse(localStorage.getItem(storageKey(project)) ?? "[]"));
    return new Set(parsed.success ? parsed.data : []);
  } catch {
    return new Set();
  }
}

export function usePinnedAgents(project: string): {
  pinned: ReadonlySet<string>;
  togglePinned: (path: string) => void;
} {
  const [held, setHeld] = useState<{ project: string; pinned: ReadonlySet<string> }>();
  useEffect(() => setHeld({ project, pinned: readPins(project) }), [project]);
  const togglePinned = useCallback(
    (path: string) =>
      setHeld((previous) => {
        const next = new Set(previous?.project === project ? previous.pinned : readPins(project));
        if (!next.delete(path)) next.add(path);
        try {
          localStorage.setItem(storageKey(project), JSON.stringify([...next]));
        } catch {
          // storage refused: the pin holds for this page's life
        }
        return { project, pinned: next };
      }),
    [project],
  );
  return {
    pinned: held?.project === project ? held.pinned : NONE,
    togglePinned,
  };
}
