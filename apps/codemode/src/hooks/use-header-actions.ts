import { useState, type ReactNode } from "react";

export function useHeaderActions() {
  return useState<ReactNode>(null);
}
