export const OPEN_GLOBAL_COMMAND_PALETTE_EVENT = "iterate:open-command-palette";

export function openGlobalCommandPalette() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_GLOBAL_COMMAND_PALETTE_EVENT));
}
