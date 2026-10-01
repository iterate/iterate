/** A plain left click — not a modified one (cmd/ctrl/shift/alt: a new tab or window), not the
 *  middle button, not one something else already handled. */
export function plainLeftClick(
  event: Pick<
    MouseEvent,
    "defaultPrevented" | "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
  >,
) {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}
