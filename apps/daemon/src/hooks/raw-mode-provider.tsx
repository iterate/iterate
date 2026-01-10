import { useState, useRef } from "react";

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
  const [rawEventsCount, setRawEventsCountState] = useState(0);
  const lastCountRef = useRef(0);

  const setRawMode = (value: boolean) => {
    setRawModeState(value);
    localStorage.setItem(STORAGE_KEY, String(value));
  };

  const setRawEventsCount = (count: number) => {
    if (count !== lastCountRef.current) {
      lastCountRef.current = count;
      setRawEventsCountState(count);
    }
  };

  return (
    <RawModeContext.Provider value={{ rawMode, setRawMode, rawEventsCount, setRawEventsCount }}>
      {children}
    </RawModeContext.Provider>
  );
}
