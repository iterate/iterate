import { createContext, useContext, useState, useLayoutEffect, type ReactNode } from "react";

type SetActions = (actions: ReactNode) => void;
const HeaderActionsContext = createContext<SetActions | null>(null);

/** Provider for header actions slot - wrap around layout content */
export function HeaderActionsProvider({
  children,
  onActionsChange,
}: {
  children: ReactNode;
  onActionsChange: SetActions;
}) {
  return (
    <HeaderActionsContext.Provider value={onActionsChange}>
      {children}
    </HeaderActionsContext.Provider>
  );
}

/** Render children in the header actions slot */
export function HeaderActions({ children }: { children: ReactNode }) {
  const setActions = useContext(HeaderActionsContext);

  useLayoutEffect(() => {
    setActions?.(children);
    return () => setActions?.(null);
  }, [children, setActions]);

  return null;
}

/** Hook for layouts to manage header actions state */
export function useHeaderActions() {
  return useState<ReactNode>(null);
}
