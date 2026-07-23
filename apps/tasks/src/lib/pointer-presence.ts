import { useEffect, useRef, useState } from "react";
import { withProject, withProjectOnce, whoami } from "./use-checkout.ts";
import type { TasksWorkspace } from "./tasks-api.ts";

/**
 * Figma-style mouse-pointer presence for the board. The pointer is anchored
 * SEMANTICALLY — the nearest `[data-pointer-anchor]` element plus fractional
 * offsets within it — so it lands on the same card/column for every
 * participant regardless of their viewport or sidebar state. The payload
 * also carries the sender's view (filter/group/open task) so a receiver can
 * jump to it. Sends are trailing-throttled; receipt is one long-poll loop
 * against the workspace's pointer channel.
 */

export type PointerPayload = {
  anchor: string;
  fx: number;
  fy: number;
  /** Set briefly on mousedown — receivers render a click pulse. */
  click?: boolean;
  name: string;
  view: { group: string; q: string; task: string };
};

export type RemotePointer = { at: number; clientId: string; payload: PointerPayload };

const SEND_THROTTLE_MS = 120;

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "someone";

function isPointerPayload(value: unknown): value is PointerPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.anchor === "string" &&
    typeof record.fx === "number" &&
    typeof record.fy === "number"
  );
}

export function usePointerPresence(
  checkoutId: string,
  repoPath: string,
  view: { group: string; q: string; task: string },
): RemotePointer[] {
  const [pointers, setPointers] = useState<RemotePointer[]>([]);
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  });

  useEffect(() => {
    const lane = <T,>(operation: (ws: TasksWorkspace) => Promise<T>, once = false) =>
      (once ? withProjectOnce : withProject)((project) =>
        operation(
          (project as { workspace(c: string, r?: string): unknown }).workspace(
            checkoutId,
            repoPath,
          ) as TasksWorkspace,
        ),
      );

    let clientId = `u-someone-${Math.random().toString(36).slice(2, 8)}`;
    let displayName = "someone";
    void whoami()
      .then((me) => {
        const name = me.name ?? me.email ?? me.userId;
        if (name) {
          displayName = name;
          clientId = `u-${slugify(name)}-${Math.random().toString(36).slice(2, 8)}`;
        }
      })
      .catch(() => {});

    let stopped = false;

    // -- send lane: trailing-throttled mousemove/mousedown ---------------------
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: { anchor: string; click?: boolean; fx: number; fy: number } | null = null;
    const flush = () => {
      timer = null;
      if (stopped || pending === null) return;
      const payload: PointerPayload = {
        ...pending,
        name: displayName,
        view: { ...viewRef.current },
      };
      pending = null;
      void lane((ws) => ws.pointerPresent(clientId, payload), true).catch(() => {});
    };
    const capture = (event: MouseEvent, click: boolean) => {
      const target = (event.target as Element | null)?.closest?.("[data-pointer-anchor]") ?? null;
      const element = target ?? document.documentElement;
      const anchor = target?.getAttribute("data-pointer-anchor") ?? "page";
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      pending = {
        anchor,
        fx: (event.clientX - rect.left) / rect.width,
        fy: (event.clientY - rect.top) / rect.height,
        ...(click || pending?.click ? { click: true } : {}),
      };
      // Clicks jump the throttle so pulses feel immediate.
      if (click && timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      timer ??= setTimeout(flush, click ? 0 : SEND_THROTTLE_MS);
    };
    const onMove = (event: MouseEvent) => capture(event, false);
    const onDown = (event: MouseEvent) => capture(event, true);
    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("mousedown", onDown, { passive: true });

    // -- receive lane: one long-poll loop -------------------------------------
    let generation = 0;
    let failures = 0;
    const poll = async (): Promise<void> => {
      while (!stopped) {
        try {
          const snapshot = await lane((ws) => ws.pointerWait(generation));
          if (stopped) return;
          failures = 0;
          generation = snapshot.generation;
          setPointers(
            snapshot.clients.flatMap((client) =>
              client.clientId !== clientId && isPointerPayload(client.payload)
                ? [{ at: client.at, clientId: client.clientId, payload: client.payload }]
                : [],
            ),
          );
        } catch {
          if (stopped) return;
          failures++;
          if (failures > 8) return; // quiet surrender — pointers are decoration
          await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** failures, 10_000)));
        }
      }
    };
    void poll();

    return () => {
      stopped = true;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mousedown", onDown);
      if (timer !== null) clearTimeout(timer);
      void lane((ws) => ws.pointerPresent(clientId, null), true).catch(() => {});
    };
  }, [checkoutId, repoPath]);

  return pointers;
}
