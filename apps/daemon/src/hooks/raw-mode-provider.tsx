import { useState } from "react";

import { RawModeContext } from "./use-raw-mode.ts";

const STORAGE_KEY = "daemon:rawMode";

function getInitialRawMode(): boolean {
  if (typeof window === "undefined") return false;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === null) return false;
  return stored === "true";
}

export function RawModeProvider({ children }: { children: React.ReactNode }) {
  const [rawMode, setRawModeState] = useState(getInitialRawMode);

  const setRawMode = (value: boolean) => {
    setRawModeState(value);
    localStorage.setItem(STORAGE_KEY, String(value));
  };

  return (
    <RawModeContext.Provider value={{ rawMode, setRawMode }}>{children}</RawModeContext.Provider>
  );
}
