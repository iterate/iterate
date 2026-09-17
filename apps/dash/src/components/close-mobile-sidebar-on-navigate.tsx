import { useEffect, useRef } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useSidebar } from "@iterate-com/ui/components/sidebar";

/** Dismiss the mobile sidebar (a Sheet) when the route changes — shadcn's Sidebar exposes
 *  `setOpenMobile` and does not do this itself. Only on an actual pathname change, never on
 *  mount: the Sheet remounts its children when opened. (apps/os carries the same helper.) */
export function CloseMobileSidebarOnNavigate() {
  const { setOpenMobile } = useSidebar();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const previousPathnameRef = useRef(pathname);
  useEffect(() => {
    if (previousPathnameRef.current === pathname) return;
    previousPathnameRef.current = pathname;
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);
  return null;
}
