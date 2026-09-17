import { useEffect, useRef } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useSidebar } from "@iterate-com/ui/components/sidebar";

/** Dismiss the mobile sidebar (a Sheet) when the page navigates — shadcn's Sidebar exposes
 *  `setOpenMobile` and does not do this itself. This app navigates by search string (`/agents?
 *  project=…&agent=…`), so the whole href is what counts, not the pathname. Only on an actual
 *  change, never on mount: the Sheet remounts its children when opened. */
export function CloseMobileSidebarOnNavigate() {
  const { setOpenMobile } = useSidebar();
  const href = useRouterState({ select: (state) => state.location.href });
  const previousHrefRef = useRef(href);
  useEffect(() => {
    if (previousHrefRef.current === href) return;
    previousHrefRef.current = href;
    setOpenMobile(false);
  }, [href, setOpenMobile]);
  return null;
}
