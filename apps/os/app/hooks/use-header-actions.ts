import { useState, type ReactNode } from "react";

/** Hook for layouts to manage header actions state */
export function useHeaderActions() {
  return useState<ReactNode>(null);
}
