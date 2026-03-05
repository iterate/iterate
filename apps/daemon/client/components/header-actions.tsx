import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { HEADER_ACTIONS_ID } from "./header-actions-constants.ts";

interface HeaderActionsProps {
  children: ReactNode;
}

/**
 * Portal component to render action buttons in the header's right side.
 * Use this on mobile to place page actions in the header instead of the content area.
 *
 * @example
 * <HeaderActions>
 *   <Button className="md:hidden" size="sm">
 *     <Plus className="h-4 w-4" />
 *   </Button>
 * </HeaderActions>
 */
export function HeaderActions({ children }: HeaderActionsProps) {
  const [container, setContainer] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const element = document.getElementById(HEADER_ACTIONS_ID);
    setContainer(element);
  }, []);

  if (!container) return null;

  return createPortal(children, container);
}
