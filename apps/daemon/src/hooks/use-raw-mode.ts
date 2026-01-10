import { createContext, useContext } from "react";

export interface RawModeContextValue {
  rawMode: boolean;
  setRawMode: (value: boolean) => void;
  rawEventsCount: number;
  setRawEventsCount: (count: number) => void;
}

export const RawModeContext = createContext<RawModeContextValue | null>(null);

export function useRawMode() {
  const context = useContext(RawModeContext);
  if (!context) {
    throw new Error("useRawMode must be used within a RawModeProvider");
  }
  return context;
}
