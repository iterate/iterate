---
status: done
size: small
---

# Fix redundant stream path tooltip in project sidebar

## Status summary

Done and verified in local dev with a headless browser. Sidebar nav items no longer show a tooltip at all; the streams-tree tooltip (abbreviated labels) still opens, now to the right of the label instead of on top of the row above.

## Problem

Hovering a project nav item in the sidebar (e.g. `/scheduler`) shows a tooltip that says… `/scheduler`, rendered directly on top of the nav item above it. It repeats text that's already fully visible, and it blocks the neighboring item. "Worse than useless" — verbatim user feedback.

Root cause: `packages/ui/src/components/events/stream-path-label.tsx` (`EventsStreamPathLabel`) unconditionally wraps the label in a tooltip showing the full path, with the default `side="top"`. The component's intent is good — show the full path when the label is truncated or abbreviated (as in the streams tree, where only the last segment is displayed) — but it fires even when the displayed text _is_ the full path and fits completely, which is always the case for sidebar nav items.

Note the `SidebarMenuButton tooltip={label}` prop is _not_ the culprit — that one correctly hides itself unless the sidebar is icon-collapsed. The offending tooltip comes from `EventsStreamPathLabel` inside the button.

## Fix

In `EventsStreamPathLabel`:

- [x] Suppress the tooltip when it adds no information: the displayed text equals the tooltip's full path AND the text is not truncated. Measure truncation at hover time (`scrollWidth > clientWidth`) inside base-ui's `onOpenChange` and call `eventDetails.cancel()` — no state, no effects. (Verified base-ui `TooltipStore` honors `isCanceled`.) _Implemented in `packages/ui/src/components/events/stream-path-label.tsx`; the text span gained `data-slot="stream-path-label-text"` so the handler can measure it via `eventDetails.trigger`._
- [x] When the tooltip does show (truncated label, or abbreviated label like the streams tree's last-segment display), position it `side="right"` so it never covers the list item above. _`<TooltipContent side="right">` in the same file._

## Decisions / assumptions

- Fix in the shared component rather than dropping the tooltip from the sidebar call site: the same redundant behavior would bite any future usage, and the streams tree keeps its genuinely useful full-path tooltip.
- Abbreviated labels (`label !== path`) keep their tooltip even when untruncated — it reveals the full path, which is real information.
- No automated test: the behavior is hover + CSS layout measurement, which jsdom can't exercise. Verified manually in local dev instead.

## Implementation log

- Verified base-ui `1.2.0` `Tooltip.Root` `onOpenChange` receives `eventDetails.cancel()` and `TooltipStore.setOpen` early-returns when `isCanceled` — hover-time suppression works uncontrolled.
- Verified end-to-end in local dev (worktree dev server + headless Chrome via agent-browser, minted session): hovering sidebar `/scheduler` opens no visible tooltip (the only `[data-slot=tooltip-content]` in the DOM is the sidebar-collapse one, correctly `display: none` when expanded); hovering the streams-tree node `agents` (abbreviated label) opens the `/agents` tooltip with `data-side="right"`.
- The user-reported tooltip was NOT the `SidebarMenuButton tooltip` prop (that one hides itself when the sidebar is expanded) — it was `EventsStreamPathLabel`'s own unconditional tooltip.
