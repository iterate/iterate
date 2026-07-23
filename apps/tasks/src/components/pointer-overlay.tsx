import { useEffect, useReducer } from "react";
import { authorColor } from "../lib/collab-redline.ts";
import type { RemotePointer } from "../lib/pointer-presence.ts";

/**
 * Everyone else's mouse pointer: an arrow + name flag in the author's color,
 * anchored to the same semantic element the sender hovered (cards, columns,
 * the sheet) so it lands correctly across viewport layouts. Positions
 * re-resolve on scroll/resize; movement eases via a CSS transform
 * transition. Clicking a flag jumps to that person's view.
 */
export function PointerOverlay({
  pointers,
  onJumpToView,
}: {
  pointers: RemotePointer[];
  onJumpToView: (view: { group: string; q: string; task: string }) => void;
}) {
  // Scroll and resize move anchor rects without any React state changing —
  // re-render on those (rAF-coalesced) so pointers stay glued.
  const [, bump] = useReducer((tick: number) => tick + 1, 0);
  useEffect(() => {
    let frame: number | null = null;
    const schedule = () => {
      frame ??= requestAnimationFrame(() => {
        frame = null;
        bump();
      });
    };
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[60]">
      {pointers.map((pointer) => {
        const anchored =
          pointer.payload.anchor === "page"
            ? document.documentElement
            : document.querySelector(`[data-pointer-anchor="${CSS.escape(pointer.payload.anchor)}"]`);
        if (anchored === null) return null;
        const rect = anchored.getBoundingClientRect();
        const x = rect.left + pointer.payload.fx * rect.width;
        const y = rect.top + pointer.payload.fy * rect.height;
        if (x < -20 || y < -20 || x > window.innerWidth + 20 || y > window.innerHeight + 20) {
          return null;
        }
        const color = authorColor(pointer.clientId, 1);
        const recentClick = pointer.payload.click === true;
        return (
          <div
            key={pointer.clientId}
            className="absolute top-0 left-0 transition-transform duration-100 ease-linear will-change-transform"
            style={{ transform: `translate(${x}px, ${y}px)` }}
          >
            {recentClick ? (
              <span
                className="absolute -top-2 -left-2 size-5 animate-ping rounded-full opacity-60"
                style={{ backgroundColor: color }}
              />
            ) : null}
            <svg width="16" height="18" viewBox="0 0 16 18" className="drop-shadow-sm">
              <path
                d="M1 1 L15 8.5 L8.5 10 L5.5 17 Z"
                fill={color}
                stroke="white"
                strokeWidth="1"
              />
            </svg>
            <button
              type="button"
              onClick={() => onJumpToView(pointer.payload.view)}
              title={`Jump to ${pointer.payload.name}'s view`}
              className="pointer-events-auto ml-3 -mt-0.5 block max-w-40 cursor-pointer truncate rounded-md rounded-tl-none px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-white"
              style={{ backgroundColor: color }}
            >
              {pointer.payload.name}
            </button>
          </div>
        );
      })}
    </div>
  );
}
